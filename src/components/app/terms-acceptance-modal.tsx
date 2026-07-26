"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Modal that gates the (app) shell when the user hasn't accepted
 * the current Terms of Service. The (app) layout passes the
 * effective date so a single source of truth (lib/compliance/
 * constants) drives both the gate and the modal copy.
 *
 * We deliberately render this as a fixed-position overlay rather
 * than a route-level redirect: the user should still see the
 * dashboard background (and the brand mark) so the experience
 * reads as "we updated our terms" rather than "you're locked
 * out". Sign-out is offered as the explicit decline path.
 */
export function TermsAcceptanceModal({
  effectiveDate,
}: {
  effectiveDate: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onAccept = () => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await fetch("/api/me/terms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!r.ok) {
          setError("Couldn't record your acceptance. Please try again.");
          return;
        }
        // Force a re-fetch of the layout so the modal disappears.
        router.refresh();
      } catch {
        setError("Network error — please try again.");
      }
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tos-modal-heading"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-background p-6 shadow-xl">
        <h2
          id="tos-modal-heading"
          className="text-lg font-semibold text-foreground"
        >
          We&apos;ve updated our Terms.
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Our Terms of Service and Privacy Policy were updated effective{" "}
          <strong className="text-foreground">{effectiveDate}</strong>.
          Please review and accept to continue using InterviewReplay.
        </p>
        <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
          <li>
            &middot;{" "}
            <Link
              href="/terms"
              target="_blank"
              className="text-foreground underline"
            >
              Read the Terms of Service
            </Link>
          </li>
          <li>
            &middot;{" "}
            <Link
              href="/privacy"
              target="_blank"
              className="text-foreground underline"
            >
              Read the Privacy Policy
            </Link>
          </li>
        </ul>

        {error && (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button asChild variant="outline">
            <Link href="/api/auth/signout">Sign out</Link>
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={onAccept}
            disabled={isPending}
          >
            {isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            I&apos;ve read and accept
          </Button>
        </div>
      </div>
    </div>
  );
}
