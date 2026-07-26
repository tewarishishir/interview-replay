import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { features } from "@/lib/env";
import { googleSignInAction } from "@/lib/auth/actions";
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
  robots: { index: false, follow: false },
};

export default async function SignUpPage() {
  if (features.inviteOnlyBeta) {
    notFound();
  }

  return (
    <Card className="border-border">
      <CardHeader className="space-y-1.5 text-center">
        <CardTitle className="text-2xl tracking-tight">
          Create your account
        </CardTitle>
        <CardDescription>
          Get started with InterviewReplay.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {features.googleAuth && (
          <>
            <form action={googleSignInAction} className="space-y-3">
              <input type="hidden" name="callbackUrl" value="/dashboard" />
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

        <SignUpForm />

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
