"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";

interface AnalyzeButtonProps {
  sessionId: string;
  /**
   * Number of credits the API will charge. We display this in the
   * button label so the user has full price clarity at click time.
   */
  creditsRequired: number;
  /**
   * `true` when the user has enough credits to start. When false,
   * we render a "Buy credits" link instead of the analyze action.
   */
  canAfford: boolean;
  /**
   * Whether this submit click is a RE-ANALYSIS (a prior report
   * exists for the session) rather than a first analysis. The
   * label copy switches accordingly: "Re-analyze (1 credit)" vs.
   * "Submit for analysis (N credits)". Server computes this from
   * the reports table and passes it down — the client doesn't
   * need to know about the ledger.
   */
  isReanalysis?: boolean;
}

/**
 * Client island that fires `POST /api/sessions/:id/analyze` and
 * routes the candidate to the report page on a 202.
 *
 * We choose `router.push` (not `assign`) on success so the back
 * button still works — the candidate can return to the submit
 * preview to re-read their context, even though re-analysis is
 * the more common reason to come back.
 */
export function AnalyzeButton({
  sessionId,
  creditsRequired,
  canAfford,
  isReanalysis = false,
}: AnalyzeButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!canAfford) {
    return (
      <Button asChild variant="primary" size="lg">
        <a href="/credits/buy">Buy credits</a>
      </Button>
    );
  }

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      let res: Response;
      try {
        res = await fetch(`/api/sessions/${sessionId}/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch (err) {
        // `fetch` only rejects on transport-level failures — DNS,
        // offline, server unreachable, request aborted by the
        // browser, mixed-content block. We log at `warn` (not
        // `error`) because this is a fully-handled user path: the
        // alert state below is the authoritative surface. In Next
        // 15's dev overlay any `console.error` from a caught path
        // pops the giant "Console TypeError" panel on top of the
        // already-rendered inline error, which is exactly the kind
        // of double-surface we don't want.
        const isNetworkError =
          err instanceof TypeError ||
          (err as { name?: string })?.name === "AbortError";
        console.warn("[AnalyzeButton] analyze fetch failed:", err);
        setError(
          isNetworkError
            ? "Couldn't reach the server. Check your connection and try again."
            : "Something went wrong. Please try again.",
        );
        return;
      }

      try {
        if (res.status === 402) {
          // Race: another tab consumed credits between page render
          // and click. Send the user to /credits/buy.
          router.push("/credits/buy");
          return;
        }

        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            message?: string;
          };
          setError(
            data.message ??
              `Couldn't start analysis (${res.status}). Please try again.`,
          );
          return;
        }

        // 202 Accepted — the worker is processing. Send the
        // candidate to the session detail page; that page will
        // poll / refresh to show "analyzing" → "complete".
        router.push(`/sessions/${sessionId}`);
        router.refresh();
      } catch (err) {
        console.warn("[AnalyzeButton] analyze response handling failed:", err);
        setError("Something went wrong. Please try again.");
      }
    });
  };

  const label = (() => {
    if (creditsRequired === 0) {
      return "Re-analyze (free, within 24h)";
    }
    if (isReanalysis) {
      return `Re-analyze (${creditsRequired} credit${
        creditsRequired === 1 ? "" : "s"
      })`;
    }
    return `Submit for analysis (${creditsRequired} credit${
      creditsRequired === 1 ? "" : "s"
    })`;
  })();

  return (
    <div className="flex flex-col items-center gap-3">
      <Button
        type="button"
        variant="primary"
        size="lg"
        disabled={pending}
        onClick={handleClick}
      >
        {pending ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Starting analysis…
          </>
        ) : (
          <>
            <Sparkles className="size-4" aria-hidden />
            {label}
          </>
        )}
      </Button>
      {error && (
        <p
          role="alert"
          className="text-sm"
          style={{ color: "rgb(190, 18, 60)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
