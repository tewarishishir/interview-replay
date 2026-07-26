"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Printer, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";

interface SessionActionsProps {
  sessionId: string;
}

/**
 * Sidebar action cluster on the report page. Two buttons:
 *
 *   1. "Print / PDF" — `window.print()`. We rely on a browser-native
 *      stylesheet for now per spec ("defer real PDF gen to later").
 *
 *   2. "Delete" — confirms via `window.confirm` (cheap, accessible),
 *      then DELETEs to /api/sessions/:id. Routes back to /dashboard.
 *
 * Re-analyze was removed: the "free within 24h" label was misleading
 * because the API still charged credits in some cases, so we cut the
 * entry point entirely rather than ship a half-trustworthy price.
 */
export function SessionActions({ sessionId }: SessionActionsProps) {
  const router = useRouter();
  const [deletePending, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handlePrint = () => {
    window.print();
  };

  const handleDelete = () => {
    if (
      !window.confirm(
        "Delete this session? The transcript and report will be removed.",
      )
    ) {
      return;
    }
    setError(null);
    startDelete(async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            message?: string;
          };
          setError(data.message ?? `Couldn't delete (${res.status}).`);
          return;
        }
        router.push("/dashboard");
        router.refresh();
      } catch (err) {
        console.error("[SessionActions] delete failed:", err);
        setError("Something went wrong. Please try again.");
      }
    });
  };

  return (
    <div className="space-y-2 print:hidden">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={handlePrint}
      >
        <Printer className="size-4" aria-hidden />
        Print / PDF
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="w-full text-destructive hover:bg-destructive/5"
        style={{ color: "rgb(190, 18, 60)" }}
        disabled={deletePending}
        onClick={handleDelete}
      >
        {deletePending ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Deleting…
          </>
        ) : (
          <>
            <Trash2 className="size-4" aria-hidden />
            Delete session
          </>
        )}
      </Button>
      {error && (
        <p
          role="alert"
          className="mt-2 text-sm"
          style={{ color: "rgb(190, 18, 60)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
