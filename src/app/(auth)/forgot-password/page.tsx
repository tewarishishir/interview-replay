import Link from "next/link";
import type { Metadata } from "next";

import { requestPasswordResetAction } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const metadata: Metadata = {
  title: "Forgot password",
  // Keep out of search results: the page leaks no useful content
  // for SEO, and `?sent=1`-style flashes can briefly land in
  // crawler snippets if indexed.
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ sent?: string; error?: string }>;
}

const KNOWN_ERROR_MESSAGES: Record<string, string> = {
  rate_limited:
    "Too many reset requests from this network. Wait an hour and try again.",
  invalid_email: "Please enter a valid email address.",
};

const sanitizeError = (raw: string | undefined): string | null => {
  if (typeof raw !== "string") return null;
  return KNOWN_ERROR_MESSAGES[raw] ?? null;
};

export default async function ForgotPasswordPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const sent = params.sent === "1";
  const errorMessage = sanitizeError(params.error);

  // Once the user has submitted, render a generic success view
  // regardless of whether an account exists. The reset endpoint
  // must NOT confirm existence — that's the anti-enumeration
  // contract enforced by `requestPasswordResetAction`.
  if (sent) {
    return (
      <Card className="border-border">
        <CardHeader className="space-y-1.5 text-center">
          <CardTitle className="text-2xl tracking-tight">
            Check your email
          </CardTitle>
          <CardDescription>
            If an account exists with the email you entered, we just sent
            a password-reset link. It expires in 1 hour.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 text-sm text-muted-foreground">
          <p>
            Can&apos;t find it? Check your spam folder, then{" "}
            <Link
              href="/forgot-password"
              className="text-foreground underline underline-offset-2"
            >
              try again
            </Link>
            .
          </p>
          <p className="border-t border-border pt-4 text-center">
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
          Forgot your password?
        </CardTitle>
        <CardDescription>
          Enter your email and we&apos;ll send you a link to reset it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {errorMessage && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {errorMessage}
          </p>
        )}

        <form action={requestPasswordResetAction} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              autoFocus
            />
          </div>
          <Button type="submit" className="w-full">
            Send reset link
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Remembered it?{" "}
          <Link
            href="/signin"
            className="text-foreground underline underline-offset-2"
          >
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
