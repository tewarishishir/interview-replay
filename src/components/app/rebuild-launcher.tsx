"use client";

import { ArrowRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  RebuildApiError,
  postRebuild,
} from "@/lib/rebuilds/api-client";
import type { CreateRebuildInput } from "@/lib/rebuilds/schemas";

/**
 * Client-only "Rebuild a story for this →" trigger.
 *
 * Two visual variants:
 *
 *   - `variant="inline"` (default). Small, secondary. Used by the
 *     report view under each rebuild-eligible improvement card —
 *     the only consumer in the product today.
 *   - `variant="card"`. Slightly more prominent, full width on
 *     narrow screens. Originally surfaced inside the
 *     "Strengthen your story bank" cards at the bottom of the
 *     report; that section was folded into the inline buttons in
 *     the rebuild-refactor (the diagnosis + action are now the
 *     same card, no more duplication). Kept as a styling option
 *     for a future surface (dashboard / rebuild list / etc.) so
 *     the per-callsite layout choice doesn't have to fork the
 *     button component.
 *
 * On click we:
 *   1. POST `/api/rebuilds` with the source session/improvement
 *      pre-filled. The API does its own validation; we only
 *      surface its error message.
 *   2. Push the user to `/rebuilds/{id}` so the 6-step flow takes
 *      over. We let `router.push` follow the soft-nav so the
 *      report's scroll position is preserved if the user clicks
 *      back.
 *
 * Analytics:
 *   The `rebuild_started` event is fired here (client-side) with
 *   the `source` property the spec asks for. The server-side
 *   create route also fires server-side analytics — we deliberately
 *   double-emit because the funnel separately needs to know the
 *   user clicked vs. that a row was created (network failures,
 *   abandons, etc). The `report_bottom` source value is no longer
 *   emitted by this component (the bottom section is gone) but is
 *   still classified by the API route from body shape, so existing
 *   analytics dashboards continue to render historic rows.
 */
type Variant = "inline" | "card";
type Source =
  | "report_inline"
  | "report_bottom"
  | "standalone"
  // Per-session Analytics tab → per-question card. Tracked
  // separately from the Improvements-tab launchers so the funnel
  // can attribute rebuild volume to the Analytics surface (the new
  // tab in Prompt 3) without conflating it with the existing
  // inline buttons under each Improvement card.
  | "report_analytics_card";

interface Props {
  source: Source;
  payload: CreateRebuildInput;
  /** Override label — defaults differ by variant. */
  label?: string;
  variant?: Variant;
  className?: string;
}

export function RebuildLauncher({
  source,
  payload,
  label,
  variant = "inline",
  className,
}: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setError(null);
    setPending(true);
    try {
      const { rebuild } = await postRebuild(payload);
      fireRebuildStarted(source, payload);
      router.push(`/rebuilds/${rebuild.id}`);
    } catch (err) {
      setError(
        err instanceof RebuildApiError
          ? err.message
          : "We couldn't start your rebuild. Try again.",
      );
      setPending(false);
    }
  };

  const buttonLabel =
    label ??
    (variant === "card" ? "Start rebuild" : "Rebuild a story for this");

  return (
    <div className={className}>
      <Button
        type="button"
        variant={variant === "card" ? "primary" : "ghost"}
        size="sm"
        onClick={onClick}
        disabled={pending}
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : null}
        {buttonLabel}
        <ArrowRight className="size-3.5" aria-hidden />
      </Button>
      {error && (
        <p className="mt-1 text-xs text-rose-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function fireRebuildStarted(
  _source: Source,
  _payload: CreateRebuildInput,
): void {
  // No-op: external analytics removed for open-source.
}
