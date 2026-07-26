import type { OutcomeType } from "@/lib/db/schema/outcomes";

/**
 * Minimal outcome shape required by the context formatter.
 * Subset of OutcomeCardData / SessionOutcome — kept narrow so the
 * formatter stays testable without a full DB row.
 */
export interface OutcomeContextInput {
  outcomeType: OutcomeType;
  /** When the user heard back from the company. */
  outcomeReceivedAt: Date | null;
  /**
   * When the user added this outcome to InterviewReplay.
   * Used as the reference point for "no response" age calculations.
   */
  recordedAt: Date;
}

/**
 * Produce the optional secondary context string shown after the
 * outcome label in the compact OutcomeRow.
 *
 * Returns null when there is no meaningful context to display
 * (e.g. no date is available for outcomes that depend on a date).
 */
export function formatOutcomeContext(
  outcome: OutcomeContextInput,
): string | null {
  if (outcome.outcomeType === "no_response") {
    const weeksElapsed = Math.floor(
      (Date.now() - outcome.recordedAt.getTime()) /
        (7 * 24 * 60 * 60 * 1_000),
    );
    if (weeksElapsed < 1) return "Less than a week since interview";
    if (weeksElapsed === 1) return "1 week since interview";
    return `${weeksElapsed} weeks since interview`;
  }

  if (!outcome.outcomeReceivedAt) return null;

  if (outcome.outcomeType === "received_offer") {
    return `Got the offer ${formatShortDate(outcome.outcomeReceivedAt)}`;
  }

  if (outcome.outcomeType === "withdrew") {
    return `On ${formatShortDate(outcome.outcomeReceivedAt)}`;
  }

  // advanced_to_next_round, did_not_advance, other
  return `Heard back ${formatShortDate(outcome.outcomeReceivedAt)}`;
}

export function formatShortDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-IN", { month: "short", day: "numeric" });
}
