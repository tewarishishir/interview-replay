"use client";

import { useState, useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

interface Props {
  id: string;
}

/**
 * Inline delete button for a rebuild row on the list page.
 *
 * Calls DELETE /api/rebuilds/:id (soft-delete → status = 'discarded')
 * and refreshes the server component so the row disappears without a
 * full page reload. Uses useTransition so the delete is non-blocking
 * and the loading state is visually contained to the button.
 */
export function DeleteRebuildButton({ id }: Props) {
  const router = useRouter();
  const [pending, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (pending) return;
    setError(null);
    startDelete(async () => {
      try {
        const res = await fetch(`/api/rebuilds/${id}`, { method: "DELETE" });
        if (res.ok) {
          router.refresh();
          return;
        }
        let payload: { message?: string } = {};
        try {
          payload = await res.json();
        } catch {
          /* best-effort */
        }
        setError(payload.message ?? "Couldn't delete. Please try again.");
      } catch {
        setError("Couldn't reach the server. Please try again.");
      }
    });
  };

  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onClick}
        disabled={pending}
        aria-label="Delete rebuild"
        className="size-8 shrink-0 text-muted-foreground/50 transition-colors hover:text-destructive hover:bg-destructive/10 focus-visible:text-destructive"
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Trash2 className="size-3.5" aria-hidden />
        )}
      </Button>
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
