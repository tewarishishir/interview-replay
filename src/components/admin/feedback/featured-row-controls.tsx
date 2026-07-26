"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ChevronDown, ChevronUp, Loader2, StarOff } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Per-row controls in the admin "Featured" section — up / down /
 * unfeature. Sibling component to `FeedbackActions` (the cluster
 * shown in the main queue table); this one is specific to the
 * curation tray at the top of `/admin/feedback`.
 *
 * Actions:
 *   - Up   → `POST /api/admin/feedback/[id]/move` with direction='up'
 *   - Down → `POST /api/admin/feedback/[id]/move` with direction='down'
 *   - Off  → `POST /api/admin/feedback/[id]/feature` with featured=false
 *
 * `isFirst` / `isLast` disable the appropriate arrow at the
 * boundaries. The server treats a boundary move as a 200 no-op, but
 * the UI guard means the admin doesn't get a useless click — and
 * the disabled state makes the list order legible at a glance.
 */
export function FeaturedRowControls({
  id,
  isFirst,
  isLast,
}: {
  id: string;
  isFirst: boolean;
  isLast: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const move = (direction: "up" | "down") => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await fetch(`/api/admin/feedback/${id}/move`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ direction }),
        });
        if (!r.ok) {
          const data = (await r.json().catch(() => ({}))) as {
            message?: string;
          };
          setError(data.message ?? `Request failed (${r.status})`);
          return;
        }
        router.refresh();
      } catch (err) {
        console.error("[FeaturedRowControls] move POST failed:", err);
        setError("Network error.");
      }
    });
  };

  const unfeature = () => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await fetch(`/api/admin/feedback/${id}/feature`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ featured: false }),
        });
        if (!r.ok) {
          const data = (await r.json().catch(() => ({}))) as {
            message?: string;
          };
          setError(data.message ?? `Request failed (${r.status})`);
          return;
        }
        router.refresh();
      } catch (err) {
        console.error("[FeaturedRowControls] unfeature POST failed:", err);
        setError("Network error.");
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="inline-flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending || isFirst}
          onClick={() => move("up")}
          aria-label="Move up in display order"
          title="Move up"
        >
          {isPending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <ChevronUp className="size-3.5" aria-hidden />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending || isLast}
          onClick={() => move("down")}
          aria-label="Move down in display order"
          title="Move down"
        >
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={unfeature}
          aria-label="Remove from home-page testimonials"
          title="Remove from home page"
        >
          <StarOff className="size-3.5" aria-hidden />
          Unfeature
        </Button>
      </div>
      {error && (
        <p className="text-xs" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
