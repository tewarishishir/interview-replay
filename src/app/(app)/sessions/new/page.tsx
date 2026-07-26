import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { auth } from "@/lib/auth";
import { NewSessionForm } from "@/components/app/new-session-form";

export const metadata: Metadata = {
  title: "New session",
};

/**
 * `/sessions/new` — entry point for the two-step "create a session"
 * flow. Server component: it does the auth check and renders the
 * shell, then hands off to `<NewSessionForm>` (a client component)
 * for the actual form state.
 *
 * The (app) layout already redirects unauthenticated traffic, so
 * the `auth()` call here is purely defensive — and also narrows
 * `session.user.id` for any future server-side reads we may add.
 */
export default async function NewSessionPage() {
  const session = await auth();
  if (!session?.user?.id) {
    // The literal path has no URL-special characters so encoding is
    // a no-op today, but we keep the call so the pattern matches
    // every other `/signin?callbackUrl=…` site in the app and a
    // future path with `?` or `&` in it can't sneak past unencoded.
    redirect(`/signin?callbackUrl=${encodeURIComponent("/sessions/new")}`);
  }

  return (
    <section className="mx-auto max-w-2xl px-6 py-12">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to dashboard
      </Link>

      <div className="mt-6">
        <h1 className="text-3xl font-semibold tracking-tight">
          Start a new session
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Tell us about the interview, then confirm a few important details
          before we start recording.
        </p>
      </div>

      <div className="mt-10">
        <NewSessionForm />
      </div>
    </section>
  );
}
