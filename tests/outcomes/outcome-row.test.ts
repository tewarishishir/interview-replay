import { describe, it, expect } from "vitest";

import {
  formatOutcomeContext,
  formatShortDate,
} from "@/lib/outcomes/format-context";
import { OUTCOME_DISPLAY } from "@/lib/outcomes/colors";

// ---------------------------------------------------------------------------
// formatShortDate
// ---------------------------------------------------------------------------

describe("formatShortDate", () => {
  // Use noon UTC so the date is stable across any UTC offset (-11 to +11).
  it("formats a Date object in short month + day style", () => {
    const result = formatShortDate(new Date("2024-12-14T12:00:00Z"));
    expect(result).toMatch(/dec/i);
    expect(result).toMatch(/14/);
  });

  it("accepts a string input", () => {
    const result = formatShortDate("2024-12-14T12:00:00Z");
    expect(result).toMatch(/dec/i);
    expect(result).toMatch(/14/);
  });
});

// ---------------------------------------------------------------------------
// formatOutcomeContext — no_response
// ---------------------------------------------------------------------------

describe("formatOutcomeContext — no_response", () => {
  const base = {
    outcomeType: "no_response" as const,
    outcomeReceivedAt: null,
  };

  it("returns 'Less than a week since interview' when recorded_at is < 7 days ago", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    expect(
      formatOutcomeContext({ ...base, recordedAt: threeDaysAgo }),
    ).toBe("Less than a week since interview");
  });

  it("returns '1 week since interview' when exactly 1 week has passed", () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);
    expect(
      formatOutcomeContext({ ...base, recordedAt: oneWeekAgo }),
    ).toBe("1 week since interview");
  });

  it("returns 'N weeks since interview' for multi-week gaps", () => {
    const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1_000);
    expect(
      formatOutcomeContext({ ...base, recordedAt: threeWeeksAgo }),
    ).toBe("3 weeks since interview");
  });
});

// ---------------------------------------------------------------------------
// formatOutcomeContext — received_offer
// ---------------------------------------------------------------------------

describe("formatOutcomeContext — received_offer", () => {
  const recordedAt = new Date("2024-11-01T00:00:00Z");

  it("returns null when outcomeReceivedAt is null", () => {
    expect(
      formatOutcomeContext({
        outcomeType: "received_offer",
        outcomeReceivedAt: null,
        recordedAt,
      }),
    ).toBeNull();
  });

  it("returns 'Got the offer <date>' when outcomeReceivedAt is set", () => {
    const result = formatOutcomeContext({
      outcomeType: "received_offer",
      outcomeReceivedAt: new Date("2024-12-14T12:00:00Z"),
      recordedAt,
    });
    expect(result).toMatch(/^Got the offer /);
    expect(result).toMatch(/dec/i);
    expect(result).toMatch(/14/);
  });
});

// ---------------------------------------------------------------------------
// formatOutcomeContext — withdrew
// ---------------------------------------------------------------------------

describe("formatOutcomeContext — withdrew", () => {
  const recordedAt = new Date("2024-11-01T00:00:00Z");

  it("returns null when outcomeReceivedAt is null", () => {
    expect(
      formatOutcomeContext({
        outcomeType: "withdrew",
        outcomeReceivedAt: null,
        recordedAt,
      }),
    ).toBeNull();
  });

  it("returns 'On <date>' when outcomeReceivedAt is set", () => {
    const result = formatOutcomeContext({
      outcomeType: "withdrew",
      outcomeReceivedAt: new Date("2024-12-10T12:00:00Z"),
      recordedAt,
    });
    expect(result).toMatch(/^On /);
    expect(result).toMatch(/dec/i);
    expect(result).toMatch(/10/);
  });
});

// ---------------------------------------------------------------------------
// formatOutcomeContext — advanced_to_next_round
// ---------------------------------------------------------------------------

describe("formatOutcomeContext — advanced_to_next_round", () => {
  const recordedAt = new Date("2024-11-01T00:00:00Z");

  it("returns null when outcomeReceivedAt is null", () => {
    expect(
      formatOutcomeContext({
        outcomeType: "advanced_to_next_round",
        outcomeReceivedAt: null,
        recordedAt,
      }),
    ).toBeNull();
  });

  it("returns 'Heard back <date>' when outcomeReceivedAt is set", () => {
    const result = formatOutcomeContext({
      outcomeType: "advanced_to_next_round",
      outcomeReceivedAt: new Date("2024-12-14T12:00:00Z"),
      recordedAt,
    });
    expect(result).toMatch(/^Heard back /);
    expect(result).toMatch(/dec/i);
    expect(result).toMatch(/14/);
  });
});

// ---------------------------------------------------------------------------
// formatOutcomeContext — did_not_advance
// ---------------------------------------------------------------------------

describe("formatOutcomeContext — did_not_advance", () => {
  const recordedAt = new Date("2024-11-01T00:00:00Z");

  it("returns null when outcomeReceivedAt is null", () => {
    expect(
      formatOutcomeContext({
        outcomeType: "did_not_advance",
        outcomeReceivedAt: null,
        recordedAt,
      }),
    ).toBeNull();
  });

  it("returns 'Heard back <date>' when outcomeReceivedAt is set", () => {
    const result = formatOutcomeContext({
      outcomeType: "did_not_advance",
      outcomeReceivedAt: new Date("2024-12-14T12:00:00Z"),
      recordedAt,
    });
    expect(result).toMatch(/^Heard back /);
  });
});

// ---------------------------------------------------------------------------
// OUTCOME_DISPLAY — color config for all 6 outcome types
// ---------------------------------------------------------------------------

describe("OUTCOME_DISPLAY", () => {
  const outcomeTypes = [
    "advanced_to_next_round",
    "received_offer",
    "did_not_advance",
    "withdrew",
    "no_response",
    "other",
  ] as const;

  it("has an entry for all 6 outcome types", () => {
    for (const type of outcomeTypes) {
      expect(OUTCOME_DISPLAY[type]).toBeDefined();
    }
  });

  it("every entry has a non-empty label, dotColor, and textColor", () => {
    for (const type of outcomeTypes) {
      const d = OUTCOME_DISPLAY[type];
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.dotColor.length).toBeGreaterThan(0);
      expect(d.textColor.length).toBeGreaterThan(0);
    }
  });

  it("only 'received_offer' has an icon (Trophy)", () => {
    expect(OUTCOME_DISPLAY.received_offer.icon).toBeTruthy();
    for (const type of outcomeTypes.filter((t) => t !== "received_offer")) {
      expect(OUTCOME_DISPLAY[type].icon).toBeUndefined();
    }
  });
});
