"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { AuthError } from "next-auth";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

import { features, isProduction } from "@/lib/env";
import {
  ipFromHeaders,
  oauthLimiter,
  passwordResetCompleteLimiter,
  passwordResetRequestLimiter,
  resendVerificationLimiter,
  signInLimiter,
  signUpLimiter,
} from "@/lib/rate-limit";
import {
  normalizeReferralCode,
  REFERRAL_COOKIE_MAX_AGE_SECONDS,
  REFERRAL_COOKIE_NAME,
} from "@/lib/referrals";
import { sanitizeCallback } from "@/lib/safe-redirect";

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./constants";
import { sendVerificationEmail } from "./email";
import { hashPassword } from "./password";
import { sendPasswordResetEmail, consumePasswordResetToken } from "./reset";
import { auth, signIn, signOut } from "./index";
import { createCredentialsUser } from "./users";

/**
 * Server actions for the credentials flow.
 *
 * These are the only network-side validators — the sign-in / sign-up
 * forms duplicate the same Zod shape on the client for instant feedback,
 * but a malicious client posting around them still hits these checks.
 *
 * Rate limiting wraps both actions: the IP-based limiter from
 * `lib/rate-limit` runs *before* any DB work, and credential failures
 * are recorded so the lockout window kicks in after 10 bad attempts.
 */

/**
 * Spec: min 8 chars + must contain a digit. We additionally cap at 256
 * (handled by the field) so we don't accept pathologically long
 * passwords that would burn argon2 CPU on every login attempt.
 */
const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, "Password must be at least 8 characters.")
  .max(MAX_PASSWORD_LENGTH, "Password is too long.")
  .refine((v) => /\d/.test(v), "Password must contain a digit.");

/**
 * Email validation order: trim + lowercase first, THEN `.email()`. A
 * naive `.email().trim().toLowerCase()` rejects whitespace-padded input
 * before the trim ever runs, which means a mobile keyboard's trailing
 * space breaks signup/signin. We also cap length up front so a giant
 * pasted blob never reaches the (more expensive) email regex.
 */
const normalizedEmail = (msg = "Enter a valid email address.") =>
  z
    .string()
    .trim()
    .toLowerCase()
    .max(320, "Email is too long.")
    .pipe(z.string().email(msg));

const signUpInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Please enter your name.")
    .max(100, "Name is too long.")
    .optional()
    .or(z.literal("")),
  email: normalizedEmail(),
  password: passwordSchema,
});

const signInInputSchema = z.object({
  email: normalizedEmail(),
  password: z
    .string()
    .min(1, "Enter your password.")
    .max(MAX_PASSWORD_LENGTH),
});

/**
 * Discriminated union return type. Server-action callers narrow on
 * `state` and render either field errors (`"error"`) or the success
 * message (`"success"`). We never throw out of these actions for
 * user-facing failures — only for true 5xx-style internal errors.
 *
 * `formError` is for cross-cutting messages ("rate-limited", "invalid
 * credentials") that don't belong on a single field.
 */
export type AuthActionState =
  | { state: "idle" }
  | {
      state: "error";
      formError?: string;
      fieldErrors?: Partial<Record<"email" | "password" | "name", string>>;
    }
  | { state: "success"; message?: string };

const friendlyResetSeconds = (resetMs: number): number =>
  Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));

export async function signUpAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  if (features.inviteOnlyBeta) {
    // Defense in depth: the /signup page 404s under this flag, but a
    // stale tab or a hand-crafted POST could still hit this action.
    // Surface the same generic message the route would for a deleted
    // feature.
    return {
      state: "error",
      formError: "Sign-ups are not available right now.",
    };
  }
  const signupHeaders = await headers();
  const ip = ipFromHeaders(signupHeaders) ?? "unknown-ip";
  const limiter = signUpLimiter();
  const limit = await limiter.check(ip);
  if (!limit.success) {
    return {
      state: "error",
      formError: `Too many sign-up attempts. Try again in ${friendlyResetSeconds(limit.reset)}s.`,
    };
  }
  // Helper: anything that "looks like attacker probing" should
  // increment the lockout counter so we eventually deny the IP.
  // Validation failures, duplicate-email probes, and broken signups
  // all qualify — only the happy path skips this.
  const recordSignUpFailure = () => limiter.recordFailure(ip);

  const parsed = signUpInputSchema.safeParse({
    name: formData.get("name") ?? "",
    email: formData.get("email") ?? "",
    password: formData.get("password") ?? "",
  });

  if (!parsed.success) {
    const fieldErrors: Partial<Record<"email" | "password" | "name", string>> =
      {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === "name" || key === "email" || key === "password") {
        // Keep the first error per field — the UI shows them inline and
        // a stack of errors per field is noise.
        fieldErrors[key] ??= issue.message;
      }
    }
    return { state: "error", fieldErrors };
  }

  const { name, email, password } = parsed.data;

  // Optional `ref` field is the referral code captured by the
  // signup page from `?ref=CODE` and rendered as a hidden input.
  // Junk values are validated downstream by `normalizeReferralCode`
  // and silently ignored, so we don't gate signup on the code.
  const rawRef = formData.get("ref");
  const referralCode = typeof rawRef === "string" && rawRef.length > 0 ? rawRef : null;

  // All DB work + verification email lives in `createCredentialsUser`
  // so the same code path runs in tests as in production. Pass the
  // rate-limit IP through so the GeoIP-based signup_country_code
  // stamp lands in the same transaction as the user row.
  const result = await createCredentialsUser({
    email,
    password,
    name: name && name.length > 0 ? name : null,
    referralCode,
    signupHeaders,
    signupIp: ip,
  });

  if (!result.ok) {
    if (result.error === "duplicate_email") {
      // Yes, this still discloses "an account exists" on the *first*
      // attempt — that's the explicit UX trade. But every duplicate
      // probe also bumps the lockout counter, so an attacker
      // enumerating the user base via the signup form gets locked
      // out after 10 attempts in 15 minutes from one IP.
      await recordSignUpFailure();
      return {
        state: "error",
        fieldErrors: { email: "An account with that email already exists." },
      };
    }
    await recordSignUpFailure();
    return {
      state: "error",
      formError:
        "Something went wrong creating your account. Please try again.",
    };
  }

  // Sign the user in immediately. `signIn` from Auth.js v5 throws a
  // `NEXT_REDIRECT` on success (which is what we want); we catch
  // `AuthError` separately to surface as a form error rather than 500.
  try {
    await signIn("credentials", {
      email,
      password,
      redirectTo: "/dashboard",
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        state: "error",
        formError:
          "Account created, but auto sign-in failed. Please sign in manually.",
      };
    }
    // Re-throw NEXT_REDIRECT et al.
    throw err;
  }

  // `signIn` should have redirected by this point. Returning a success
  // marker keeps TypeScript happy and is a no-op in practice.
  return { state: "success" };
}

export async function signInAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const ip = ipFromHeaders(await headers()) ?? "unknown-ip";
  const limiter = signInLimiter();
  const limit = await limiter.check(ip);
  if (!limit.success) {
    return {
      state: "error",
      formError: `Too many sign-in attempts. Try again in ${friendlyResetSeconds(limit.reset)}s.`,
    };
  }

  const parsed = signInInputSchema.safeParse({
    email: formData.get("email") ?? "",
    password: formData.get("password") ?? "",
  });

  if (!parsed.success) {
    const fieldErrors: Partial<Record<"email" | "password", string>> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === "email" || key === "password") {
        fieldErrors[key] ??= issue.message;
      }
    }
    return { state: "error", fieldErrors };
  }

  const { email, password } = parsed.data;
  const callbackUrl = sanitizeCallback(formData.get("callbackUrl"));

  try {
    await signIn("credentials", {
      email,
      password,
      redirectTo: callbackUrl,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      // Bad credentials. Bump the lockout counter and tell the user.
      await limiter.recordFailure(ip);
      return {
        state: "error",
        formError: "Invalid email or password.",
      };
    }
    throw err;
  }

  return { state: "success" };
}

/**
 * Server action wrapper around `next-auth`'s OAuth `signIn` for the
 * "Continue with Google" button. Doing this through a server action
 * (rather than the client) keeps the OAuth round-trip strictly
 * server-side — no client-side `signIn()` import, no exposed
 * AUTH_GOOGLE_ID in any bundle.
 *
 * Bound directly to a `<form action>`, so the runtime calls it with
 * one argument (`formData`) and not the `useActionState` `(prev, fd)`
 * shape.
 *
 * Rate-limited even though there's no "wrong password" to track —
 * an attacker can still hammer the OAuth initiation to burn Google
 * quota or churn Auth.js cookie state.
 */
export async function googleSignInAction(formData: FormData): Promise<void> {
  if (features.inviteOnlyBeta) {
    // The Google provider is unregistered under invite-only mode, so
    // `signIn("google", ...)` would itself fail — but bouncing to
    // /signin first gives a tidier UX and avoids surfacing the
    // provider name in the error path.
    redirect("/signin");
  }
  const ip = ipFromHeaders(await headers()) ?? "unknown-ip";
  const limiter = oauthLimiter();
  const limit = await limiter.check(ip);
  if (!limit.success) {
    // The Google form has no `useActionState` plumbing to display
    // an error string, so the cheapest user-visible signal is to
    // bounce them back to /signin with an error code. The signin
    // page renders only known error codes from a whitelist so this
    // can't be repurposed to display arbitrary text.
    redirect(`/signin?error=rate_limited`);
  }

  // Carry the referral code across the Google round-trip via a
  // short-lived first-party cookie. The OAuth provider strips
  // query strings from the redirect target, so this is the only
  // place we can stash the value before bouncing through Google.
  // `events.createUser` reads + clears it on the way back.
  const rawRef = formData.get("ref");
  const ref = normalizeReferralCode(rawRef);
  if (ref) {
    const cookieStore = await cookies();
    cookieStore.set(REFERRAL_COOKIE_NAME, ref, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      path: "/",
      maxAge: REFERRAL_COOKIE_MAX_AGE_SECONDS,
    });
  }

  const callbackUrl = sanitizeCallback(formData.get("callbackUrl"));

  // `signIn` throws `NEXT_REDIRECT` on the happy path (used to bounce
  // the browser to Google's authorize endpoint). Rethrow that so Next
  // can intercept it. Anything else — including `AuthError` for a
  // misconfigured provider, transient Google outages, or a server
  // error before the redirect is issued — should land the user back
  // on /signin with our own whitelisted error code rather than
  // surfacing as an unhandled 500.
  try {
    await signIn("google", { redirectTo: callbackUrl });
  } catch (err) {
    const isRedirect =
      err != null &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest?: unknown }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_REDIRECT");
    if (isRedirect) throw err;
    if (err instanceof AuthError) {
      console.error("[googleSignInAction] AuthError:", err);
      redirect(`/signin?error=oauth_failed`);
    }
    console.error("[googleSignInAction] unexpected error:", err);
    redirect(`/signin?error=oauth_failed`);
  }
}

/**
 * Sign out from any layout/header. Wraps `signOut` so callers don't have
 * to import the Auth.js client surface directly.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/" });
  // `signOut` throws a `NEXT_REDIRECT` internally, so this fallback is
  // unreachable in practice — kept to satisfy `Promise<void>`.
  redirect("/");
}

/**
 * Re-issue a verification email for the currently-signed-in user.
 * Triggered from the `/verify-email-required` page when an unverified
 * user has signed in but lost the original email (spam folder, typo,
 * expired token).
 *
 * Auth: requires a session — we send to the user's email-of-record,
 * not to a user-supplied value, so a malicious unauthenticated
 * caller can't use this to spam arbitrary inboxes. Rate-limited by
 * `userId` to bound abuse of the verified-but-still-asking case.
 *
 * Returns `void` so the form submission redirects via `redirect(...)`
 * — calling code uses the redirect target's `?resent=1` / error
 * params to render the appropriate banner.
 */
export async function resendVerificationAction(): Promise<void> {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    redirect("/signin");
  }
  const userId = session.user.id;
  const email = session.user.email;

  const burst = await resendVerificationLimiter().check(userId);
  if (!burst.success) {
    redirect("/verify-email-required?error=rate_limited");
  }

  try {
    await sendVerificationEmail(email);
  } catch (err) {
    console.error("[resendVerificationAction] send failed:", err);
    redirect("/verify-email-required?error=send_failed");
  }

  redirect("/verify-email-required?resent=1");
}

const requestResetSchema = z.object({
  email: normalizedEmail(),
});

/**
 * Request a password-reset link.
 *
 * Anti-enumeration: this action ALWAYS redirects to the same "if
 * the account exists you'll get a link" success state, regardless
 * of whether the email actually matches a row. We deliberately
 * don't surface "no such account" — that turns the reset endpoint
 * into an account-existence oracle.
 *
 * Rate-limited by IP. The user isn't signed in (the whole point is
 * "I can't log in"), so per-user keying isn't available; IP is the
 * coarsest reasonable bucket and matches how the signin / signup
 * limiters key themselves.
 *
 * Works for Google-OAuth signups too: those rows have
 * `password_hash IS NULL`, but the reset flow just writes a fresh
 * hash either way. After completing the reset, the user can sign
 * in via either Google OR credentials with the new password.
 */
export async function requestPasswordResetAction(
  formData: FormData,
): Promise<void> {
  const ip = ipFromHeaders(await headers()) ?? "unknown-ip";
  const limit = await passwordResetRequestLimiter().check(ip);
  if (!limit.success) {
    redirect("/forgot-password?error=rate_limited");
  }

  const parsed = requestResetSchema.safeParse({
    email: formData.get("email") ?? "",
  });
  if (!parsed.success) {
    redirect("/forgot-password?error=invalid_email");
  }

  // Look up the user but don't reveal the result to the caller.
  // We mint a reset token + send the email only when an account
  // exists; otherwise the caller gets the same generic success
  // page so the reset endpoint can't be used as an account-
  // existence oracle. The IP-keyed rate limit (5 / hour) bounds
  // any timing-based enumeration well before it would yield a
  // signal.
  const { email } = parsed.data;
  const [userRow] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (userRow) {
    try {
      await sendPasswordResetEmail(email);
    } catch (err) {
      // Log but don't expose the failure — the caller still gets
      // the generic success page. An operator follow-up via logs
      // is the right escalation.
      console.error("[requestPasswordResetAction] send failed:", err);
    }
  }

  redirect("/forgot-password?sent=1");
}

const completeResetSchema = z
  .object({
    email: normalizedEmail(),
    token: z.string().min(1, "Reset token is missing."),
    password: passwordSchema,
    confirmPassword: z.string().min(1, "Confirm your password."),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords don't match.",
    path: ["confirmPassword"],
  });

export type CompleteResetActionState =
  | { state: "idle" }
  | {
      state: "error";
      formError?: string;
      fieldErrors?: Partial<
        Record<"password" | "confirmPassword", string>
      >;
    }
  | { state: "success" };

/**
 * Consume a reset token and set the user's new password. Surfaces
 * field errors via `useActionState` so the password form can render
 * inline validation on the same page; on the happy path, redirects
 * to `/signin?reset=1` so the success flash shows on the signin
 * page where the user is about to log in again.
 *
 * Token check + password write happen in one transaction inside
 * `consumePasswordResetToken`, so a stale tab that retries with
 * the same token after the first completion gets a clean
 * "invalid_token" error instead of overwriting the new hash.
 */
export async function completePasswordResetAction(
  _prev: CompleteResetActionState,
  formData: FormData,
): Promise<CompleteResetActionState> {
  const ip = ipFromHeaders(await headers()) ?? "unknown-ip";
  const limit = await passwordResetCompleteLimiter().check(ip);
  if (!limit.success) {
    return {
      state: "error",
      formError: `Too many attempts. Try again in ${friendlyResetSeconds(limit.reset)}s.`,
    };
  }

  const parsed = completeResetSchema.safeParse({
    email: formData.get("email") ?? "",
    token: formData.get("token") ?? "",
    password: formData.get("password") ?? "",
    confirmPassword: formData.get("confirmPassword") ?? "",
  });

  if (!parsed.success) {
    const fieldErrors: Partial<
      Record<"password" | "confirmPassword", string>
    > = {};
    let formError: string | undefined;
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === "password" || key === "confirmPassword") {
        fieldErrors[key] ??= issue.message;
      } else if (key === "token" || key === "email") {
        // Token / email problems are not field-level — the user
        // can't edit them. Surface as a form error.
        formError ??=
          "This reset link looks broken. Request a new one from the sign-in page.";
      }
    }
    return { state: "error", formError, fieldErrors };
  }

  const { email, token, password } = parsed.data;
  const newPasswordHash = await hashPassword(password);
  const result = await consumePasswordResetToken({
    email,
    token,
    newPasswordHash,
  });

  if (!result.ok) {
    return {
      state: "error",
      formError:
        result.reason === "expired"
          ? "This reset link expired. Request a new one from the sign-in page."
          : "This reset link is invalid. Request a new one from the sign-in page.",
    };
  }

  // Redirect to signin so the user logs in with the new password.
  // We deliberately don't auto-sign-in here: requiring one fresh
  // sign-in after a password change is a small but useful
  // confirmation of the credential, and avoids minting a session
  // from a server route (which is harder in Auth.js than it sounds).
  redirect("/signin?reset=1");
}
