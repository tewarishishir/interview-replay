import { describe, expect, it } from "vitest";

import {
  creditsForDuration,
  DurationOutOfRangeError,
  effectiveCreditBalance,
  formatCreditsDecimal,
  freeReanalysisAvailable,
  isFreeReanalysis,
  MAX_BILLABLE_SECONDS,
  RE_ANALYSIS_FREE_WINDOW_MS,
  REBUILD_CRITIQUE_CREDIT_COST,
  REBUILD_CRITIQUE_UNITS_PER_CREDIT,
} from "@/lib/credits";

describe("creditsForDuration", () => {
  it("charges 1 credit for the smallest valid duration", () => {
    expect(creditsForDuration(1)).toBe(1);
    expect(creditsForDuration(60)).toBe(1);
    expect(creditsForDuration(30 * 60)).toBe(1);
  });

  it("charges 2 credits at 30:01 — the bucket boundary is exclusive on the upper edge", () => {
    expect(creditsForDuration(30 * 60 + 1)).toBe(2);
    expect(creditsForDuration(60 * 60)).toBe(2);
  });

  it("charges 3 credits between 60:01 and 90:00", () => {
    expect(creditsForDuration(60 * 60 + 1)).toBe(3);
    expect(creditsForDuration(90 * 60)).toBe(3);
  });

  it("charges 4 credits between 90:01 and 120:00 (the cap)", () => {
    expect(creditsForDuration(90 * 60 + 1)).toBe(4);
    expect(creditsForDuration(MAX_BILLABLE_SECONDS)).toBe(4);
  });

  it("rejects > 120 minutes with DurationOutOfRangeError", () => {
    expect(() => creditsForDuration(MAX_BILLABLE_SECONDS + 1)).toThrowError(
      DurationOutOfRangeError,
    );
  });

  it("rejects 0 / negative / non-finite durations", () => {
    expect(() => creditsForDuration(0)).toThrowError(DurationOutOfRangeError);
    expect(() => creditsForDuration(-30)).toThrowError(DurationOutOfRangeError);
    expect(() => creditsForDuration(Number.NaN)).toThrowError(
      DurationOutOfRangeError,
    );
    expect(() => creditsForDuration(Number.POSITIVE_INFINITY)).toThrowError(
      DurationOutOfRangeError,
    );
  });
});

describe("isFreeReanalysis", () => {
  const NOW = new Date("2026-05-06T12:00:00Z");

  it("is false when there is no prior report (first analysis)", () => {
    expect(isFreeReanalysis({ lastReportAt: null, now: NOW })).toBe(false);
  });

  it("is true when the prior report was 1 minute ago", () => {
    const at = new Date(NOW.getTime() - 60 * 1000);
    expect(isFreeReanalysis({ lastReportAt: at, now: NOW })).toBe(true);
  });

  it("is true when the prior report was 23h59m59s ago (just inside the window)", () => {
    const at = new Date(NOW.getTime() - (RE_ANALYSIS_FREE_WINDOW_MS - 1000));
    expect(isFreeReanalysis({ lastReportAt: at, now: NOW })).toBe(true);
  });

  it("is false when the prior report was exactly 24h ago (window is exclusive)", () => {
    const at = new Date(NOW.getTime() - RE_ANALYSIS_FREE_WINDOW_MS);
    expect(isFreeReanalysis({ lastReportAt: at, now: NOW })).toBe(false);
  });

  it("is false when the prior report was 25 hours ago", () => {
    const at = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    expect(isFreeReanalysis({ lastReportAt: at, now: NOW })).toBe(false);
  });
});

describe("freeReanalysisAvailable", () => {
  const NOW = new Date("2026-05-06T12:00:00Z");
  const RECENT = new Date(NOW.getTime() - 60 * 1000);
  const STALE = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);

  it("is true when in the 24h window AND the free re-run is unused", () => {
    expect(
      freeReanalysisAvailable({
        lastReportAt: RECENT,
        freeReanalysisAlreadyUsed: false,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("is false when the free re-run has already been used, even within the 24h window", () => {
    // The headline rule the user asked for: one free re-run per
    // session, no matter how recent the prior report is.
    expect(
      freeReanalysisAvailable({
        lastReportAt: RECENT,
        freeReanalysisAlreadyUsed: true,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("is false outside the 24h window, regardless of whether the free re-run was used", () => {
    expect(
      freeReanalysisAvailable({
        lastReportAt: STALE,
        freeReanalysisAlreadyUsed: false,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      freeReanalysisAvailable({
        lastReportAt: STALE,
        freeReanalysisAlreadyUsed: true,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("is false when there is no prior report (first analysis)", () => {
    expect(
      freeReanalysisAvailable({
        lastReportAt: null,
        freeReanalysisAlreadyUsed: false,
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("effectiveCreditBalance", () => {
  // Decimal balance = integer credit_balance - units / N. The
  // header pill and the credits-history "current balance" card
  // both use this so the displayed number is what the user can
  // actually spend on the next AI call (NOT the over-reporting
  // integer column right before a rollover).

  it("returns the integer balance when units=0 (no sub-credits in flight)", () => {
    expect(effectiveCreditBalance(10, 0)).toBe(10);
    expect(effectiveCreditBalance(0, 0)).toBe(0);
  });

  it("subtracts one unit of cost per accumulator unit", () => {
    expect(effectiveCreditBalance(10, 1)).toBeCloseTo(
      10 - REBUILD_CRITIQUE_CREDIT_COST,
      6,
    );
    expect(effectiveCreditBalance(10, 3)).toBeCloseTo(
      10 - 3 * REBUILD_CRITIQUE_CREDIT_COST,
      6,
    );
  });

  it("at the rollover boundary (N-1) reports the integer minus (N-1)/N", () => {
    const unitsAtBoundary = REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1;
    expect(effectiveCreditBalance(10, unitsAtBoundary)).toBeCloseTo(
      10 - unitsAtBoundary / REBUILD_CRITIQUE_UNITS_PER_CREDIT,
      6,
    );
    // Specifically for N=5, that's 10 - 4/5 = 9.20.
    expect(effectiveCreditBalance(10, 4)).toBeCloseTo(9.2, 6);
  });

  it("tolerates null/undefined units (falls back to the integer balance)", () => {
    // Defensive: a caller that forgets to select the column gets
    // the same answer as the legacy integer-only display rather
    // than a NaN.
    expect(effectiveCreditBalance(10, null)).toBe(10);
    expect(effectiveCreditBalance(10, undefined)).toBe(10);
  });
});

describe("formatCreditsDecimal", () => {
  // Pinned to two-decimal output so balances align vertically in
  // the header pill and the history table.

  it("formats whole balances with two decimal places", () => {
    expect(formatCreditsDecimal(10)).toBe("10.00");
    expect(formatCreditsDecimal(0)).toBe("0.00");
  });

  it("formats fractional balances at two decimal places", () => {
    expect(formatCreditsDecimal(9.2)).toBe("9.20");
    expect(formatCreditsDecimal(0.4)).toBe("0.40");
  });

  it("survives non-finite inputs without crashing the header", () => {
    expect(formatCreditsDecimal(Number.NaN)).toBe("0.00");
    expect(formatCreditsDecimal(Number.POSITIVE_INFINITY)).toBe("0.00");
  });
});
