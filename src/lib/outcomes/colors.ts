import type { OutcomeType } from "@/lib/db/schema/outcomes";

// Re-export so consumers can `import { OutcomeType } from "@/lib/outcomes/colors"`
// without having to know the originating module.
export type { OutcomeType };

/**
 * Outcome color system — single source of truth for how each
 * interview outcome is visually represented across the app
 * (OutcomeRow, dashboard cards, session rows, admin views).
 *
 * Design principles:
 *   - "Did not advance" uses muted coral, NOT red. A negative
 *     interview result is informational, not an emergency.
 *   - "No response" gets amber because the candidate is still
 *     waiting — it's in-flight, not closed.
 *   - "Received offer" and "Advanced" both use the teal success
 *     color; "Received offer" adds the trophy icon for distinction.
 *   - Withdrawn / Other stay deliberately quiet (gray).
 *
 * Colors reference CSS variables so light/dark adaptation is free.
 */
export interface OutcomeDisplay {
  label: string;
  dotColor: string;
  textColor: string;
  /**
   * Optional icon discriminator. Currently only set for
   * "received_offer" to differentiate it from "advanced_to_next_round"
   * despite sharing the same teal color. The value "trophy" signals
   * the Lucide Trophy icon in OutcomeRow.
   */
  icon?: string;
}

export const OUTCOME_DISPLAY: Record<OutcomeType, OutcomeDisplay> = {
  advanced_to_next_round: {
    label: "Advanced to next round",
    dotColor: "var(--color-success)",
    textColor: "var(--color-success)",
  },
  received_offer: {
    label: "Received an offer",
    dotColor: "var(--color-success)",
    textColor: "var(--color-success)",
    icon: "trophy",
  },
  did_not_advance: {
    label: "Did not advance",
    dotColor: "var(--color-outcome-negative)",
    textColor: "var(--color-outcome-negative)",
  },
  withdrew: {
    label: "I withdrew",
    dotColor: "var(--color-text-secondary)",
    textColor: "var(--color-text-secondary)",
  },
  no_response: {
    label: "No response yet",
    dotColor: "var(--color-warning)",
    textColor: "var(--color-warning)",
  },
  other: {
    label: "Other",
    dotColor: "var(--color-text-secondary)",
    textColor: "var(--color-text-secondary)",
  },
};
