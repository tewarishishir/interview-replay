"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * The outcome card on the report view. Two render states:
 *
 *   1. No outcome recorded yet  →  prompt + "Record outcome" CTA.
 *   2. Outcome recorded         →  null (the compact OutcomeRow below
 *                                  the session header handles display).
 *
 * The outcome data is rendered from server-side props. When an
 * outcome is already recorded, OutcomeRow (in report/OutcomeRow.tsx)
 * shows the compact colored indicator above the two-column layout.
 *
 * Load-bearing UI principle: this card NEVER modifies, replaces, or
 * contradicts the existing report. The original AI analysis stays
 * exactly as it was; outcome is independent context shown alongside.
 */

export type OutcomeType =
  | "advanced_to_next_round"
  | "received_offer"
  | "did_not_advance"
  | "withdrew"
  | "no_response"
  | "other";

export interface OutcomeCardData {
  outcomeType: OutcomeType;
  outcomeReceivedAt: Date | null;
  recordedAt: Date;
  nextRoundType: string | null;
  feedbackReceived: string | null;
  reflectionNotes: string | null;
  wouldChange: string | null;
  /**
   * When the session/interview took place. Used to compute
   * "Heard back N days after the interview" relative display.
   * Optional: falls back to absolute date when absent.
   */
  sessionCreatedAt?: Date | null;
}

interface OutcomeCardProps {
  sessionId: string;
  outcome: OutcomeCardData | null;
  /**
   * Hiring company for the round. Used by the no-outcome empty
   * state to soften the copy. Optional; falls back to "the company".
   */
  companyName?: string | null;
}

export function OutcomeCard({
  sessionId,
  outcome,
  companyName = null,
}: OutcomeCardProps) {
  // Empty-state analytics ping. Fires once per page load when the
  // user opens the report and has not yet recorded an outcome.
  useEffect(() => {
    // Analytics event placeholder (external tracking removed).
  }, [outcome, sessionId]);

  // When an outcome is already recorded it's shown as the compact
  // OutcomeRow below the session header (above the two-column layout).
  // This card only renders the "no outcome yet" prompt.
  if (outcome !== null) return null;

  return <EmptyOutcomeCard sessionId={sessionId} companyName={companyName} />;
}

/* ──────────────────────────────────────────────────────────── */
/*                          Empty state                          */
/* ──────────────────────────────────────────────────────────── */

/**
 * No-outcome placeholder.
 *
 * Stacked layout (heading → body → CTA) so the card reads
 * top-to-bottom on every viewport. The CTA renders as a solid
 * default button below the copy. No left-border accent — accent
 * borders are reserved for the recorded states in OutcomeRow.
 *
 * Fires `outcome_record_clicked_from_quiet_state` analytics event on
 * the CTA so we can track the click-through funnel.
 */
function EmptyOutcomeCard({
  sessionId,
  companyName: _companyName,
}: {
  sessionId: string;
  companyName: string | null;
}) {
  const onRecordClick = () => {
    // Analytics event placeholder (external tracking removed).
  };

  return (
    <section
      aria-label="Interview outcome"
      data-print-hide
      data-testid="outcome-card-empty"
      className="mb-8 rounded-xl print:hidden"
      style={{
        background: "var(--color-bg-secondary)",
        padding: "1.25rem",
      }}
    >
      <h2
        className="font-medium tracking-tight text-foreground"
        style={{ fontSize: "15px" }}
      >
        How did this interview go?
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Once you hear back from the company, record the outcome here.
        We&apos;ll use it to track your progress over time and improve your
        coaching.
      </p>
      <div className="mt-4">
        <Button asChild size="sm" variant="default" onClick={onRecordClick}>
          <Link href={`/sessions/${sessionId}/outcome`}>Record outcome</Link>
        </Button>
      </div>
    </section>
  );
}
