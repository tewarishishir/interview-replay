import Link from "next/link";
import type { Metadata } from "next";

import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Reset password",
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ token?: string; email?: string }>;
}

/**
 * Landing page for the reset link emitted by
 * `sendPasswordResetEmail`. Renders the password-set form if the
 * URL carries both `token` and `email`, otherwise renders a
 * "broken link" error with a path back to `/forgot-password`.
 *
 * We deliberately DON'T pre-validate the token here. The completion
 * action revalidates atomically anyway, so a "this link is invalid"
 * page that lies about freshness (rendered ok now, but expires by
 * the time the user submits) would be a worse experience than just
 * letting them try.
 *
 * Same flow serves Google-OAuth users setting a first password.
 * Nothing here gates on `users.password_hash` being non-null — the
 * completion action writes the hash regardless.
 */
export default async function ResetPasswordPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const email = typeof params.email === "string" ? params.email : "";

  if (!token || !email) {
    return (
      <Card className="border-border">
        <CardHeader className="space-y-1.5 text-center">
          <CardTitle className="text-2xl tracking-tight">
            Reset link broken
          </CardTitle>
          <CardDescription>
            We couldn&apos;t read the reset details from this URL. Request
            a fresh link to try again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Link
            href="/forgot-password"
            className="block w-full rounded-md border border-border bg-background px-3 py-2 text-center text-sm font-medium hover:bg-muted"
          >
            Request a new reset link
          </Link>
          <p className="text-center text-sm text-muted-foreground">
            Back to{" "}
            <Link
              href="/signin"
              className="text-foreground underline underline-offset-2"
            >
              Sign in
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border">
      <CardHeader className="space-y-1.5 text-center">
        <CardTitle className="text-2xl tracking-tight">
          Choose a new password
        </CardTitle>
        <CardDescription>
          Setting the password for{" "}
          <span className="font-medium text-foreground">{email}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ResetPasswordForm token={token} email={email} />

        <p className="text-center text-sm text-muted-foreground">
          Changed your mind?{" "}
          <Link
            href="/signin"
            className="text-foreground underline underline-offset-2"
          >
            Sign in instead
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}
