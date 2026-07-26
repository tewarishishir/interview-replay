"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, Loader2, Star, StarOff, Undo2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { FeedbackStatus } from "@/lib/db/schema";

/**
 * Inline action cluster for a row in the admin feedback queue.
 *
 * Renders the buttons that apply to the row's current status:
 *
 *   - pending  → Approve, Reject
 *   - approved → Reject, Move back to pending, Feature/Unfeature
 *   - rejected → Approve, Move back to pending
 *
 * Each status button drives a single `PATCH /api/admin/feedback/[id]`
 * with the target status. The Feature/Unfeature button drives
 * `POST /api/admin/feedback/[id]/feature`. On success the page is
 * refreshed via `router.refresh()` — the page server-renders the
 * filtered queue so a refresh is the simplest way to surface the
 * new state without local cache invalidation logic.
 *
 * The Feature button only renders for `approved` rows where the
 * submitter opted into public display (`consentPublic=true`).
 * Featuring an unconsented row is impossible at the API edge too
 * (and at the DB layer via the CHECK constraint from migration
 * 0030) — this UI guard just hides the affordance so an admin
 * never clicks something that would 409.
 *
 * Errors render inline below the row's button cluster (the queue
 * page table layout has space for it). A toast surface is
 * intentionally not added — this is a low-traffic admin tool, an
 * inline label is honest about what failed.
 */
export function FeedbackActions({
  id,
  status,
  consentPublic,
  featured,
}: {
  id: string;
  status: FeedbackStatus;
  consentPublic: boolean;
  featured: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submitStatus = (next: FeedbackStatus) => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await fetch(`/api/admin/feedback/${id}`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: next }),
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
        console.error("[FeedbackActions] PATCH failed:", err);
        setError("Network error.");
      }
    });
  };

  const submitFeature = (next: boolean) => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await fetch(`/api/admin/feedback/${id}/feature`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ featured: next }),
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
        console.error("[FeedbackActions] feature POST failed:", err);
        setError("Network error.");
      }
    });
  };

  // Only approved rows with consent are eligible for the home-page
  // testimonials surface. Hide the affordance for everything else —
  // the API + DB would reject it anyway, but the cleanest UX is to
  // not offer impossible actions.
  const canShowFeatureButton =
    status === "approved" && consentPublic;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="inline-flex items-center gap-1">
        {status !== "approved" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => submitStatus("approved")}
            aria-label="Approve feedback"
          >
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Check className="size-3.5" aria-hidden />
            )}
            Approve
          </Button>
        )}
        {status !== "rejected" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => submitStatus("rejected")}
            aria-label="Reject feedback"
          >
            <X className="size-3.5" aria-hidden />
            Reject
          </Button>
        )}
        {status !== "pending" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => submitStatus("pending")}
            aria-label="Move back to pending"
          >
            <Undo2 className="size-3.5" aria-hidden />
            Undo
          </Button>
        )}
        {canShowFeatureButton && (
          <Button
            type="button"
            variant={featured ? "ghost" : "outline"}
            size="sm"
            disabled={isPending}
            onClick={() => submitFeature(!featured)}
            aria-label={
              featured
                ? "Remove from home-page testimonials"
                : "Feature on home-page testimonials"
            }
            title={
              featured
                ? "Remove from home page"
                : "Show on home page"
            }
          >
            {featured ? (
              <StarOff className="size-3.5" aria-hidden />
            ) : (
              <Star className="size-3.5" aria-hidden />
            )}
            {featured ? "Unfeature" : "Feature"}
          </Button>
        )}
      </div>
      {error && (
        <p className="text-xs" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
