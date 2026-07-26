import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Sparkles } from "lucide-react";

import { features } from "@/lib/env";
import { googleSignInAction } from "@/lib/auth/actions";
import { normalizeReferralCode, resolveReferrerByCode } from "@/lib/referrals";
import { GoogleButton } from "@/components/auth/google-button";
import { SignUpForm } from "@/components/auth/sign-up-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Sign up",
  // Sign-up is a gateway; keeping it out of search results avoids
  // SEO pollution and prevents any accidental snippet capture of
  // form chrome.
  robots: { index: false, follow: false },
};

interface SignUpPageProps {
  /**
   * `?ref=CODE` carries the referral attribution. The shape is
   * validated by `normalizeReferralCode`; junk values are silently
   * dropped (no error to a brand-new user) and we then verify the
   * code points at a real, non-deleted referrer before showing the
   * invite banner. Invalid codes simply don't render the banner
   * and don't pre-populate the credentials form's hidden input.
   */
  searchParams: Promise<{ ref?: string }>;
}

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  if (features.inviteOnlyBeta) {
    // Closed-beta gate. We use notFound() rather than a friendly
    // "invite-only" page because the latter would advertise that
    // signups are coming and invite probing. A 404 is the same
    // response you'd get for any non-existent route.
    notFound();
  }
  const params = await searchParams;
  const normalizedCode = normalizeReferralCode(params.ref);

  // Only set the hidden form input + cookie-bait if the code
  // actually resolves to a real account. Any other state (junk,
  // unknown code, soft-deleted referrer) silently degrades to the
  // organic signup flow.
  const referrer = normalizedCode
    ? await resolveReferrerByCode({ code: normalizedCode })
    : null;
  const refToCarry = referrer ? normalizedCode : null;

  return (
    <Card className="border-border">
      <CardHeader className="space-y-1.5 text-center">
        <CardTitle className="text-2xl tracking-tight">
          Create your account
        </CardTitle>
        <CardDescription>
          Your first analysis is free. No credit card required.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {refToCarry && (
          <div
            role="status"
            className="flex items-start gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-sm"
          >
            <Sparkles
              className="mt-0.5 size-4 shrink-0 text-emerald-700"
              aria-hidden
            />
            <div>
              <p className="font-medium text-foreground">
                You were invited by a friend.
              </p>
              <p className="text-muted-foreground">
                You&apos;ll start with free credits when you sign up.
              </p>
            </div>
          </div>
        )}

        {features.googleAuth && (
          <>
            <form action={googleSignInAction} className="space-y-3">
              <input type="hidden" name="callbackUrl" value="/dashboard" />
              {refToCarry && (
                <input type="hidden" name="ref" value={refToCarry} />
              )}
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

        <SignUpForm referralCode={refToCarry} />

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/signin" className="text-foreground hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
