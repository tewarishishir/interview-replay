"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * "Retry" CTA shown on the report page when a session is in
 * `failed` state, or above a fallback-stub report. Drives the
 * full reset + re-analyze flow in a single click — no detour
 * through the /submit confirmation page.
 *
 * Under the hood:
 *
 *   1. POST /api/sessions/:id/reset
 *      Flips the session back to its pre-analysis state (`review`
 *      if there's no prior report, `complete` if this was a re-
 *      analysis that failed, or a no-op state-wise on the
 *      `complete + fallback` path). Server picks the target — the
 *      client doesn't need to know which.
 *   2. POST /api/sessions/:id/analyze
 *      Triggers the analyze worker.
 *   3. router.refresh()
 *      Stays on the session detail page; the next render shows
 *      the `AnalyzingPanel` (driven by the new `analyzing` state).
 *      Replaces the prior UX which pushed the user to `/submit`
 *      — a second confirmation step was pure friction.
 *
 * Why no `window.confirm`: this is an entirely safe action — the
 * session is already failed (or has a fallback stub), no data is
 * being destroyed, and the cost shown alongside the button is
 * the contract the user is consenting to by clicking. A modal
 * here would be friction for zero risk.
 *
 * Errors surface inline rather than alert()-ing — the user is
 * stuck on the report page anyway, an inline message is enough
 * to route them to support if needed.
 */
export function RetryButton({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      try {
        const resetRes = await fetch(`/api/sessions/${sessionId}/reset`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
        });
        if (!resetRes.ok) {
          const data = (await resetRes.json().catch(() => ({}))) as {
            message?: string;
          };
          setError(data.message ?? `Couldn't retry (${resetRes.status}).`);
          return;
        }

        // Reset succeeded — kick off the analyze. The route is
        // the same one `AnalyzeButton` calls from /submit, so all
        // the pricing / free-re-run / state-machine logic is the
        // single source of truth there.
        const analyzeRes = await fetch(
          `/api/sessions/${sessionId}/analyze`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
        );

        if (!analyzeRes.ok) {
          const data = (await analyzeRes.json().catch(() => ({}))) as {
            message?: string;
          };
          setError(
            data.message ??
              `Couldn't start analysis (${analyzeRes.status}). Please try again.`,
          );
          // Refresh anyway so the page reflects the post-reset
          // state (the session is no longer in `failed`); the
          // user can re-try from the resulting view.
          router.refresh();
          return;
        }

        // 202 Accepted — worker is processing. Stay on the same
        // page; refresh() re-renders the session detail page,
        // which now reads the `analyzing` state and swaps in the
        // AnalyzingPanel.
        router.refresh();
      } catch (err) {
        console.error("[RetryButton] retry failed:", err);
        setError("Something went wrong. Please try again.");
      }
    });
  };

  return (
    <div className={className}>
      <Button
        type="button"
        variant="default"
        onClick={handleClick}
        disabled={pending}
      >
        {pending ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Retrying…
          </>
        ) : (
          <>
            <RotateCcw className="size-4" aria-hidden />
            Retry
          </>
        )}
      </Button>
      {error && (
        <p
          role="alert"
          className="mt-2 inline-flex items-center gap-1 text-xs text-destructive"
          style={{ color: "rgb(190, 18, 60)" }}
        >
          <AlertTriangle className="size-3.5" aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}
