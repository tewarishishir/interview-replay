"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";

interface AnalyzeButtonProps {
  sessionId: string;
  isReanalysis?: boolean;
}

export function AnalyzeButton({
  sessionId,
  isReanalysis = false,
}: AnalyzeButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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

        router.push(`/sessions/${sessionId}`);
        router.refresh();
      } catch (err) {
        console.warn("[AnalyzeButton] analyze response handling failed:", err);
        setError("Something went wrong. Please try again.");
      }
    });
  };

  const label = isReanalysis ? "Re-analyze" : "Submit for analysis";

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
