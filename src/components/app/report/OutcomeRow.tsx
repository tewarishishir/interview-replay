import Link from "next/link";
import { Trophy } from "lucide-react";

import { OUTCOME_DISPLAY } from "@/lib/outcomes/colors";
import {
  formatOutcomeContext,
  type OutcomeContextInput,
} from "@/lib/outcomes/format-context";

interface OutcomeRowProps {
  sessionId: string;
  /**
   * When null the row renders nothing — the "How did this interview
   * go?" EmptyOutcomeCard in the main column already prompts the
   * user to record an outcome.
   */
  outcome: OutcomeContextInput | null;
}

/**
 * Compact outcome indicator placed directly below the session
 * header (company / role / level · round) and above the main
 * two-column layout.
 *
 * Renders a colored dot, the outcome label, optional context text,
 * and an Edit link. Returns null when no outcome has been recorded
 * so the prompt card in the main column can remain the sole CTA.
 *
 * This is a server component — no client-side state needed.
 */
export function OutcomeRow({ sessionId, outcome }: OutcomeRowProps) {
  if (!outcome) return null;

  const display = OUTCOME_DISPLAY[outcome.outcomeType];
  // Guard against unknown/legacy outcome types (e.g. 'rejected' before
  // migration 0031 renamed it to 'did_not_advance').
  if (!display) return null;

  const contextText = formatOutcomeContext(outcome);

  return (
    <div
      role="status"
      aria-label={`Interview outcome: ${display.label}`}
      data-testid="outcome-row"
      className="mt-6 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md px-3.5 py-2.5 text-[13px] print:hidden"
      style={{ background: "var(--color-bg-secondary)" }}
    >
      {/* Colored dot — purely decorative, label carries the meaning */}
      <span
        className="inline-block size-2 flex-shrink-0 rounded-full"
        style={{ backgroundColor: display.dotColor }}
        aria-hidden="true"
      />

      {/* Outcome label with optional trophy icon */}
      <span
        className="inline-flex items-center gap-1.5 font-medium"
        style={{ color: display.textColor }}
      >
        {display.label}
        {Boolean(display.icon) && (
          <Trophy
            className="size-3.5"
            aria-hidden="true"
            style={{ color: display.textColor }}
          />
        )}
      </span>

      {/* Optional date / elapsed-time context */}
      {contextText && (
        <>
          <span
            className="text-xs"
            style={{ color: "var(--color-text-tertiary)" }}
            aria-hidden="true"
          >
            ·
          </span>
          <span
            className="text-xs"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {contextText}
          </span>
        </>
      )}

      {/* Edit link — right-aligned via margin-left: auto */}
      <Link
        href={`/sessions/${sessionId}/outcome`}
        className="ml-auto text-xs hover:underline"
        style={{ color: "var(--color-info)" }}
        data-print-hide
      >
        Edit
      </Link>
    </div>
  );
}
