import { cookies, headers } from "next/headers";
import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { env, features } from "@/lib/env";
import { geoFromHeaders } from "@/lib/geoip";
import { ipFromHeaders } from "@/lib/rate-limit";
import {
  REFERRAL_COOKIE_NAME,
  resolveReferrerByCode,
  setReferralCodeOnTx,
  setReferredByOnTx,
} from "@/lib/referrals";

import { authConfig } from "./config";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  SIGNUP_BONUS_CREDITS,
} from "./constants";
import { sendVerificationEmail } from "./email";
import { verifyPassword } from "./password";
import { verifyCredentials } from "./users";

/**
 * Email is normalized (trim + lowercase) at the edge of the system so a
 * single user can't accidentally register `Alice@Example.com` and
 * `alice@example.com` as two accounts.
 *
 * Order matters: trim and lowercase BEFORE `.email()` so that mobile
 * keyboards' trailing-space autocomplete (e.g. " alice@example.com ")
 * normalizes cleanly instead of failing the email shape check.
 */
export const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(320) // RFC 5321 practical cap
    .pipe(z.string().email()),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH),
});

/**
 * NOTE on session strategy.
 *
 * The original spec asked for `session: { strategy: "database" }` "since
 * we're using Drizzle". Auth.js v5 does not support database sessions
 * with the Credentials provider — attempting it crashes with
 * `UnsupportedStrategy: Signing in with credentials only supported if
 * JWT strategy is enabled` (see authjs.dev/getting-started/authentication/credentials).
 *
 * We therefore stay on JWT for both Credentials *and* OAuth (mixing
 * strategies isn't supported either). Defense-in-depth for revocation is
 * the per-request DB existence check in `src/app/(app)/layout.tsx`, plus
 * the `events.signIn` hook below which catches OAuth flows the moment
 * the row is written.
 */
const fullConfig: NextAuthConfig = {
  ...authConfig,

  adapter: DrizzleAdapter(db, {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    // `interview_sessions` is our domain table; Auth.js needs its own
    // session table, exported from `schema/users.ts` as `authSessions`.
    sessionsTable: schema.authSessions,
    verificationTokensTable: schema.verificationTokens,
  }),

  providers: [
    // Google is conditional on env so a fresh dev clone without OAuth
    // credentials still boots and can use email/password sign-in.
    ...(features.googleAuth
      ? [
          Google({
            clientId: env.AUTH_GOOGLE_ID!,
            clientSecret: env.AUTH_GOOGLE_SECRET!,
            // Google's default profile callback doesn't pass through
            // `email_verified`. We re-implement it so the
            // `emailVerified` column is populated from the actual JWT
            // claim, not just stamped unconditionally on createUser.
            // For Workspace accounts whose admin disabled email
            // verification this will be false — and we'll honor that.
            profile: (profile) => ({
              id: profile.sub,
              name: profile.name,
              email: profile.email,
              image: profile.picture,
              emailVerified: profile.email_verified ? new Date() : null,
            }),
            allowDangerousEmailAccountLinking: false,
          }),
        ]
      : []),

    Credentials({
      name: "Email & password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (raw) => {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) {
          // Run a dummy verify to equalize response time with the
          // "bad password" path inside `verifyCredentials`.
          await verifyPassword(null, "");
          return null;
        }
        return verifyCredentials(parsed.data);
      },
    }),
  ],

  callbacks: {
    ...authConfig.callbacks,

    /**
     * Staging-only admin gate. When APP_ENV=staging, deny sign-in for
     * any user who doesn't have `is_admin = true` in the DB. This runs
     * after `authorize` (credentials) or after the OAuth profile is
     * resolved (Google), so `user.id` is the DB row's id.
     *
     * Returning a URL string instead of `false` lets us redirect to a
     * friendly error on the sign-in page rather than NextAuth's generic
     * "Access Denied" screen.
     */
    signIn: async ({ user }) => {
      if (env.APP_ENV !== "staging") return true;
      if (!user.id) return "/signin?error=staging_admin_only";

      try {
        const [row] = await db
          .select({ isAdmin: schema.users.isAdmin })
          .from(schema.users)
          .where(
            and(
              eq(schema.users.id, user.id),
              eq(schema.users.isAdmin, true),
              isNull(schema.users.deletedAt),
            ),
          )
          .limit(1);
        if (row) return true;
      } catch (err) {
        console.error("[auth.signIn] staging admin check failed:", err);
        return "/signin?error=staging_admin_only";
      }

      return "/signin?error=staging_admin_only";
    },
  },

  events: {
    /**
     * Fires only when the Drizzle adapter creates a new user — i.e. on
     * the first OAuth sign-in. Email/password signups create the user
     * row directly in `lib/auth/users.ts` and handle credit-ledger
     * + verification-email there, so this hook is the OAuth-only path.
     *
     * Single side-effect: write a `credit_transactions` row mirroring
     * the schema's default `credit_balance = 1`, so the running
     * balance is reproducible from the transaction stream alone.
     *
     * `emailVerified` is intentionally *not* stamped here. We rely on
     * the provider's `profile()` callback (see Google config above) to
     * populate it from the OAuth `email_verified` claim. Stamping it
     * blindly in this event would launder unverified OAuth flows
     * into "verified" — a real problem for any future provider that
     * doesn't verify email.
     */
    createUser: async ({ user }) => {
      if (!user.id) return;

      // Resolve signup country + subdivision from the OAuth-callback
      // request IP. Mirrors the credentials-signup path in
      // `lib/auth/users.ts`. Best-effort: any failure (no DB, reserved
      // IP, lookup throws) leaves both columns NULL and the rest of
      // the createUser flow continues normally.
      let oauthSignupCountryCode: string | null = null;
      let oauthSignupSubdivisionCode: string | null = null;
      try {
        const reqHeaders = await headers();
        const ip = ipFromHeaders(reqHeaders) ?? undefined;
        const geo = await geoFromHeaders(reqHeaders, ip).catch(() => ({
          countryCode: null,
          subdivisionCode: null,
        }));
        oauthSignupCountryCode = geo.countryCode;
        oauthSignupSubdivisionCode = geo.subdivisionCode;
      } catch (err) {
        console.error("[auth.createUser] geo lookup failed:", err);
      }

      // We mint exactly `SIGNUP_BONUS_CREDITS` here — the same
      // constant the credentials path uses. Reading the user row's
      // `creditBalance` and mirroring it (the previous behavior)
      // silently broke if a future migration changed the column
      // default without updating the bonus, or if an admin pre-seeded
      // a different balance before the event fired. Pinning to the
      // constant keeps the ledger reproducible from one source of
      // truth.
      //
      // We also force the user row's `creditBalance` to match the
      // constant so the column and the ledger sum stay equal even
      // if the adapter inserted a different default. Doing both
      // writes inside one transaction is the only way to keep the
      // invariant `creditBalance == sum(credit_transactions.delta)`.
      const userId = user.id;

      // Referral attribution for the OAuth flow. Form data can't
      // round-trip through Google, so the signup page sets a short-
      // lived cookie carrying `?ref=CODE` BEFORE kicking the OAuth
      // redirect. We read it here, resolve the referrer, and clear
      // the cookie regardless of whether attribution succeeded
      // (it's done its job either way and a stale value would
      // misattribute a future signup from the same browser).
      let referrerId: string | null = null;
      try {
        const cookieStore = await cookies();
        const refCookie = cookieStore.get(REFERRAL_COOKIE_NAME);
        if (refCookie?.value) {
          // Self-referral defense: pass BOTH `excludeUserId` (the
          // authoritative match) and `excludeEmail`. The email
          // check is currently unreachable in practice — Auth.js
          // enforces a unique email so the same address can't
          // map to two distinct users — but the symmetry with the
          // credentials path catches future provider configs
          // (e.g. `allowDangerousEmailAccountLinking`) before they
          // become a vulnerability.
          const referrer = await resolveReferrerByCode({
            code: refCookie.value,
            excludeUserId: userId,
            excludeEmail: user.email ?? null,
          });
          referrerId = referrer?.id ?? null;
          // Best-effort cookie clear. Some Next.js render contexts
          // disallow Set-Cookie writes (read-only RSC), in which
          // case the cookie expires naturally inside the
          // 15-minute window.
          try {
            cookieStore.delete(REFERRAL_COOKIE_NAME);
          } catch {
            // ignore: cookie store is read-only in this context
          }
        }
      } catch (err) {
        // Failing to read the cookie must not block account
        // creation. Log and proceed without attribution.
        console.error("[auth.createUser] referral cookie read failed:", err);
      }

      await db.transaction(async (tx) => {
        // Stamp the geo columns in the same UPDATE as the credit
        // balance so the OAuth signup writes a complete user row
        // in one round-trip. The columns are nullable, so passing
        // null when geo is unresolved is correct (vs. leaving the
        // existing NULL untouched — the row was just created by
        // the adapter with both columns null, so writing null is
        // a no-op for that case but doesn't hurt).
        if (
          SIGNUP_BONUS_CREDITS > 0 ||
          oauthSignupCountryCode != null ||
          oauthSignupSubdivisionCode != null
        ) {
          await tx
            .update(schema.users)
            .set({
              ...(SIGNUP_BONUS_CREDITS > 0
                ? { creditBalance: SIGNUP_BONUS_CREDITS }
                : {}),
              signupCountryCode: oauthSignupCountryCode,
              signupSubdivisionCode: oauthSignupSubdivisionCode,
            })
            .where(eq(schema.users.id, userId));

          if (SIGNUP_BONUS_CREDITS > 0) {
            await tx.insert(schema.creditTransactions).values({
              userId,
              delta: SIGNUP_BONUS_CREDITS,
              balanceAfter: SIGNUP_BONUS_CREDITS,
              reason: "signup_bonus",
            });
          }
        }

        // Mint the user's own referral code so the Account page
        // and Dashboard nudge can surface it on the very first
        // page load after signup.
        await setReferralCodeOnTx(tx, userId);

        if (referrerId) {
          await setReferredByOnTx(tx, userId, referrerId);
        }
      });

      // Send verification email for OAuth users whose provider did not
      // supply a verified email. Google almost always sets email_verified,
      // but workspace/managed accounts or future providers may not. When
      // emailVerified is null the (app) layout will gate the user behind
      // /verify-email-required, so we must dispatch the email here — the
      // credentials path handles this inside createCredentialsUser, but
      // OAuth users are created by the adapter and only reach this event.
      //
      // Auth.js types the event `user` as `User` (no emailVerified field) even
      // though the adapter always populates it from the provider profile. Query
      // the freshly-written row instead — we have userId in scope and a single
      // index hit is negligible here.
      const [freshRow] = await db
        .select({ emailVerified: schema.users.emailVerified })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      if (freshRow?.emailVerified == null && user.email) {
        try {
          await sendVerificationEmail(user.email);
        } catch (err) {
          console.error("[auth.createUser] verification email failed:", err);
        }
      }
    },
  },
};

// Re-exported so server actions can call the same helper without
// duplicating the placeholder-vs-Resend branching.
export { sendVerificationEmail };

export const { handlers, auth, signIn, signOut } = NextAuth(fullConfig);
