import Link from "next/link";
import type { Metadata } from "next";

import { features } from "@/lib/env";
import { googleSignInAction } from "@/lib/auth/actions";
import { sanitizeCallback } from "@/lib/safe-redirect";
import { GoogleButton } from "@/components/auth/google-button";
import { SignInForm } from "@/components/auth/sign-in-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Sign in",
  // Sign-in / sign-up are gateways, not landing pages — keeping them
  // out of search results avoids both SEO pollution and the (already
  // sanitized) `?error=` and `?callbackUrl=` query strings showing up
  // as snippets.
  robots: { index: false, follow: false },
};

/**
 * The `?error=` param is user-controllable. We whitelist the messages
 * we'll render so the page can't be used to display arbitrary text
 * (which would otherwise enable confusing/phishing pages of the form
 * `/signin?error=Your%20account%20has%20been%20suspended%2C%20call%20...`).
 *
 * Any unknown value renders nothing — the user just sees the form.
 */
const KNOWN_ERROR_MESSAGES: Record<string, string> = {
  rate_limited: "Too many attempts. Please try again in a moment.",
  oauth_failed: "Sign-in with that provider didn't work. Please try again.",
  email_unverified:
    "Please verify your email to continue. Check your inbox for the verification link.",
  verification_invalid:
    "That verification link is invalid. Sign in and request a fresh one.",
  verification_expired:
    "That verification link expired. Sign in and we'll send a fresh one.",
  staging_admin_only:
    "This is a staging environment. Only admin accounts can sign in here.",
};

const sanitizeError = (raw: string | string[] | undefined): string | null => {
  if (typeof raw !== "string") return null;
  return KNOWN_ERROR_MESSAGES[raw] ?? null;
};

interface SignInPageProps {
  searchParams: Promise<{
    callbackUrl?: string;
    error?: string;
    /**
     * Flash from `/api/auth/verify-email` after a successful email
     * verification. Stable, non-secret marker.
     */
    verified?: string;
    /**
     * Flash from `/reset-password` after a successful password reset.
     * Stable, non-secret marker.
     */
    reset?: string;
  }>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  const callbackUrl = sanitizeCallback(params.callbackUrl);
  // We deliberately don't show a "your session was revoked" banner.
  // The previous `?reason=revoked` signal was user-forgeable, and
  // Server Components in Next 15 can't set cookies, which rules out
  // the cleaner flash-cookie pattern. A bounced user lands on this
  // page with their `callbackUrl` intact and signs in again — no
  // information they didn't already know is exposed.
  const showCallbackNotice = Boolean(params.callbackUrl);
  const errorMessage = sanitizeError(params.error);
  // Two distinct success flashes can land on /signin:
  //   - `?verified=1` from `/api/auth/verify-email` (PR B)
  //   - `?reset=1`    from the password-reset complete action (PR C)
  // They never coincide in normal flows (a single redirect only sets
  // one), so we don't need a priority rule; the OR-chain below is
  // safe.
  const showVerifiedFlash = params.verified === "1" && !errorMessage;
  const showResetFlash = params.reset === "1" && !errorMessage;

  return (
    <Card className="border-border">
      <CardHeader className="space-y-1.5 text-center">
        <CardTitle className="text-2xl tracking-tight">Welcome back</CardTitle>
        <CardDescription>Sign in to continue to your dashboard.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {showVerifiedFlash && (
          <p
            role="status"
            className="rounded-md border border-emerald-300/60 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-950/30 dark:text-emerald-200"
          >
            Email verified. Sign in to continue.
          </p>
        )}
        {showResetFlash && (
          <p
            role="status"
            className="rounded-md border border-emerald-300/60 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-950/30 dark:text-emerald-200"
          >
            Password reset. Sign in with your new password.
          </p>
        )}
        {errorMessage && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {errorMessage}
          </p>
        )}
        {showCallbackNotice &&
          !errorMessage &&
          !showVerifiedFlash &&
          !showResetFlash && (
          <p
            role="status"
            className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
          >
            Please sign in to continue.
          </p>
        )}

        {features.googleAuth && (
          <>
            <form action={googleSignInAction} className="space-y-3">
              <input type="hidden" name="callbackUrl" value={callbackUrl} />
              <GoogleButton />
            </form>

            <div className="relative">
              <div
                aria-hidden
                className="absolute inset-0 flex items-center"
              >
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase tracking-wider">
                <span className="bg-background px-2 text-muted-foreground">
                  or
                </span>
              </div>
            </div>
          </>
        )}

        <SignInForm callbackUrl={callbackUrl} />

        <p className="text-center text-sm">
          <Link
            href="/forgot-password"
            className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Forgot your password?
          </Link>
        </p>

        {!features.inviteOnlyBeta && (
          <p className="text-center text-sm text-muted-foreground">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="text-foreground hover:underline">
              Sign up
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
