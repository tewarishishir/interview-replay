import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import {
  resendVerificationAction,
  signOutAction,
} from "@/lib/auth/actions";
import { db, schema } from "@/lib/db";
import { ResendVerificationButton } from "@/components/auth/resend-verification-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Verify your email",
  robots: { index: false, follow: false },
};

/**
 * Where signed-in-but-unverified users land after the `(app)` layout
 * gate fires. We deliberately keep this OUT of the `(app)` shell so
 * the gate doesn't loop the user back through itself.
 *
 * The page tells the user which email we sent to (from their
 * authenticated session, not from a URL param — so it can't be
 * forged) and gives them two affordances:
 *   - Resend the verification email (server action,
 *     `userId`-keyed rate-limited).
 *   - Sign out so they can re-create an account against a real inbox.
 */

interface PageProps {
  searchParams: Promise<{ resent?: string; error?: string }>;
}

const KNOWN_ERROR_MESSAGES: Record<string, string> = {
  rate_limited:
    "Too many resend attempts. Please wait an hour and try again.",
  send_failed:
    "We couldn't send the verification email. Try again in a moment.",
};

const sanitizeError = (raw: string | undefined): string | null => {
  if (typeof raw !== "string") return null;
  return KNOWN_ERROR_MESSAGES[raw] ?? null;
};

export default async function VerifyEmailRequiredPage({
  searchParams,
}: PageProps) {
  const session = await auth();
  // Unauthenticated users have nothing to verify here — bounce to
  // signin. They land back on the (app) gate after signing in if
  // they're still unverified.
  if (!session?.user?.id || !session.user.email) {
    redirect("/signin");
  }

  // Read the verification stamp directly from the DB (the session
  // doesn't carry `emailVerified`). If the user has since verified
  // — likely in another tab, or via a freshly-clicked link — send
  // them to the dashboard so this page doesn't strand them with a
  // resend UI they no longer need.
  const [row] = await db
    .select({ emailVerified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.id, session.user.id))
    .limit(1);
  if (row?.emailVerified != null) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const resent = params.resent === "1";
  const errorMessage = sanitizeError(params.error);

  return (
    <Card className="border-border">
      <CardHeader className="space-y-1.5 text-center">
        <CardTitle className="text-2xl tracking-tight">
          Check your email
        </CardTitle>
        <CardDescription>
          We sent a verification link to{" "}
          <span className="font-medium text-foreground">
            {session.user.email}
          </span>
          . Click the link to finish setting up your account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {resent && (
          <p
            role="status"
            className="rounded-md border border-emerald-300/60 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-950/30 dark:text-emerald-200"
          >
            Verification email sent. Check your inbox (and spam folder).
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

        <p className="text-sm text-muted-foreground">
          Can&apos;t find it? Check the spam folder, or click below to
          send a fresh link. The previous link will stop working.
        </p>

        <form action={resendVerificationAction}>
          <ResendVerificationButton />
        </form>

        <div className="border-t border-border pt-4 text-center text-sm text-muted-foreground">
          Used the wrong email?{" "}
          <form action={signOutAction} className="inline">
            <button
              type="submit"
              className="text-foreground underline underline-offset-2 hover:no-underline"
            >
              Sign out
            </button>
          </form>{" "}
          and{" "}
          <Link
            href="/signup"
            className="text-foreground underline underline-offset-2 hover:no-underline"
          >
            sign up again
          </Link>
          .
        </div>
      </CardContent>
    </Card>
  );
}
