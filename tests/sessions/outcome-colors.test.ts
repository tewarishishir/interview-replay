/**
 * Unit tests for the outcome color system and related
 * enum / migration changes.
 *
 * Tests:
 *   - OUTCOME_DISPLAY covers all six outcome types
 *   - 'rejected' is no longer a valid outcome type
 *   - 'did_not_advance' is a valid outcome type
 *   - OUTCOME_TYPES schema rejects 'rejected'
 *   - asked_for_feedback column exists on the schema
 *   - Each outcome has a distinct label
 *   - Accessibility: all outcomes have non-empty labels
 */
import { describe, expect, it } from "vitest";

import {
  OUTCOME_DISPLAY,
  type OutcomeType,
} from "@/lib/outcomes/colors";
import { OUTCOME_TYPES, outcomeTypeSchema } from "@/lib/db/schema/outcomes";

const ALL_OUTCOME_TYPES: OutcomeType[] = [
  "advanced_to_next_round",
  "received_offer",
  "did_not_advance",
  "withdrew",
  "no_response",
  "other",
];

describe("OUTCOME_DISPLAY", () => {
  it("contains entries for all six outcome types", () => {
    for (const type of ALL_OUTCOME_TYPES) {
      expect(OUTCOME_DISPLAY).toHaveProperty(type);
    }
  });

  it("does NOT contain an entry for the old 'rejected' type", () => {
    expect(OUTCOME_DISPLAY).not.toHaveProperty("rejected");
  });

  it("every outcome has a non-empty label (accessibility)", () => {
    for (const type of ALL_OUTCOME_TYPES) {
      const display = OUTCOME_DISPLAY[type];
      expect(display.label).toBeTruthy();
      expect(display.label.length).toBeGreaterThan(0);
    }
  });

  it("every outcome has a non-empty dotColor", () => {
    for (const type of ALL_OUTCOME_TYPES) {
      const display = OUTCOME_DISPLAY[type];
      expect(display.dotColor).toBeTruthy();
    }
  });

  it("'did_not_advance' uses the muted coral color token, NOT rose/red", () => {
    const display = OUTCOME_DISPLAY["did_not_advance"];
    expect(display.dotColor).toBe("var(--color-outcome-negative)");
    expect(display.dotColor).not.toContain("rose");
    expect(display.dotColor).not.toContain("red");
    expect(display.dotColor).not.toContain("destructive");
  });

  it("'received_offer' has a trophy icon to differentiate from 'advanced'", () => {
    expect(OUTCOME_DISPLAY["received_offer"].icon).toBeTruthy();
    expect(OUTCOME_DISPLAY["advanced_to_next_round"].icon).toBeUndefined();
  });

  it("all six labels are distinct", () => {
    const labels = ALL_OUTCOME_TYPES.map((t) => OUTCOME_DISPLAY[t].label);
    const unique = new Set(labels);
    expect(unique.size).toBe(labels.length);
  });
});

describe("OUTCOME_TYPES schema (renamed enum)", () => {
  it("contains 'did_not_advance'", () => {
    expect(OUTCOME_TYPES).toContain("did_not_advance");
  });

  it("does NOT contain 'rejected'", () => {
    expect(OUTCOME_TYPES).not.toContain("rejected");
  });

  it("has exactly 6 values", () => {
    expect(OUTCOME_TYPES).toHaveLength(6);
  });

  it("Zod schema rejects 'rejected' as an outcome_type value", () => {
    const result = outcomeTypeSchema.safeParse("rejected");
    expect(result.success).toBe(false);
  });

  it("Zod schema accepts 'did_not_advance'", () => {
    const result = outcomeTypeSchema.safeParse("did_not_advance");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("did_not_advance");
    }
  });

  it("Zod schema rejects unknown values", () => {
    const result = outcomeTypeSchema.safeParse("ghosted");
    expect(result.success).toBe(false);
  });
});

describe("session_outcomes schema — asked_for_feedback", () => {
  it("sessionOutcomes table has an askedForFeedback column", async () => {
    const { sessionOutcomes } = await import("@/lib/db/schema/outcomes");
    // The column should exist on the table definition
    expect(sessionOutcomes.askedForFeedback).toBeDefined();
  });

  it("askedForFeedback defaults to false", async () => {
    const { sessionOutcomes } = await import("@/lib/db/schema/outcomes");
    // Drizzle exposes the default via the column config
    const col = sessionOutcomes.askedForFeedback;
    expect(col.default).toBe(false);
  });
});
