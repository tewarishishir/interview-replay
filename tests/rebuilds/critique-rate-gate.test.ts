import { describe, expect, it } from "vitest";

import type { StoryRebuild } from "@/lib/db/schema";
import {
  CRITIQUE_DAILY_CAP,
  RebuildCritiqueRateLimitError,
  assertCritiqueRateOk,
  countCritiquesInLast24h,
} from "@/lib/rebuilds/critique-rate-gate";

/**
 * Pure-function tests for the per-rebuild 10/24h critique gate.
 *
 * Pinned constants:
 *   - CRITIQUE_DAILY_CAP = 10 (spec)
 *   - 24h = sliding window
 *
 * The gate counts BOTH `critique_history[i].at` entries AND the
 * current critique on `aiCritiqueJson` (whose timestamp lives on
 * the row's `updatedAt`). We assert both branches.
 */

const NOW = new Date("2026-05-09T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

type Rebuild = StoryRebuild;

function fakeRebuild(over: Partial<Rebuild> = {}): Rebuild {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    sourceSessionId: null,
    sourceImprovementIndex: null,
    questionText: "q",
    questionTheme: null,
    headline: null,
    situation: null,
    task: null,
    action: null,
    result: null,
    whatIWouldChange: null,
    aiCritiqueJson: null,
    critiqueHistory: [],
    promotedToStoryId: null,
    status: "in_progress",
    createdAt: new Date(NOW.getTime() - 5 * HOUR_MS),
    updatedAt: new Date(NOW.getTime() - 5 * HOUR_MS),
    ...over,
  } as Rebuild;
}

function entriesAt(...hoursAgo: number[]) {
  return hoursAgo.map((h) => ({
    at: new Date(NOW.getTime() - h * HOUR_MS).toISOString(),
    critique: { dimension_feedback: [] },
  }));
}

describe("countCritiquesInLast24h", () => {
  it("returns 0 when there's no history and no current critique", () => {
    expect(countCritiquesInLast24h(fakeRebuild(), NOW)).toBe(0);
  });

  it("counts only history entries inside the 24h window", () => {
    const r = fakeRebuild({
      critiqueHistory: entriesAt(0.5, 5, 23, 25, 100),
    });
    expect(countCritiquesInLast24h(r, NOW)).toBe(3);
  });

  it("counts the current critique when updatedAt is inside the window", () => {
    const r = fakeRebuild({
      aiCritiqueJson: { dimension_feedback: [] },
      updatedAt: new Date(NOW.getTime() - 2 * HOUR_MS),
      critiqueHistory: entriesAt(10),
    });
    expect(countCritiquesInLast24h(r, NOW)).toBe(2);
  });

  it("does NOT count the current critique when updatedAt is outside the window", () => {
    const r = fakeRebuild({
      aiCritiqueJson: { dimension_feedback: [] },
      updatedAt: new Date(NOW.getTime() - 30 * HOUR_MS),
    });
    expect(countCritiquesInLast24h(r, NOW)).toBe(0);
  });

  it("ignores malformed entries (no `at`, non-string `at`, unparsable date)", () => {
    const r = fakeRebuild({
      critiqueHistory: [
        ...entriesAt(1),
        // Broken entries the gate must tolerate.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        null as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { foo: "bar" } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { at: 12345 } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { at: "not-a-date" } as any,
      ],
    });
    expect(countCritiquesInLast24h(r, NOW)).toBe(1);
  });
});

describe("assertCritiqueRateOk", () => {
  it("does nothing when count < cap", () => {
    const r = fakeRebuild({
      critiqueHistory: entriesAt(...new Array(9).fill(0).map((_, i) => i + 1)),
    });
    expect(() => assertCritiqueRateOk(r, NOW)).not.toThrow();
  });

  it("throws on the (cap+1)th request inside the window", () => {
    const r = fakeRebuild({
      // 10 history entries inside the window. The 11th would be the
      // one the gate blocks; the current count of 10 is already at
      // the cap so the next call (this assert) trips.
      critiqueHistory: entriesAt(...new Array(10).fill(0).map((_, i) => i + 1)),
    });
    expect(() => assertCritiqueRateOk(r, NOW)).toThrow(
      RebuildCritiqueRateLimitError,
    );
  });

  it("counts current critique when computing the count", () => {
    // 9 history + 1 current = 10 in window → trips on the next call.
    const r = fakeRebuild({
      critiqueHistory: entriesAt(...new Array(9).fill(0).map((_, i) => i + 1)),
      aiCritiqueJson: { dimension_feedback: [] },
      updatedAt: new Date(NOW.getTime() - 0.25 * HOUR_MS),
    });
    expect(() => assertCritiqueRateOk(r, NOW)).toThrow(
      RebuildCritiqueRateLimitError,
    );
  });

  it("retryAfterSeconds is the time until the OLDEST in-window run falls off", () => {
    // Oldest in-window entry is 23h ago. Gate clears in 1h.
    const r = fakeRebuild({
      critiqueHistory: entriesAt(23, 22, 21, 20, 19, 18, 17, 16, 15, 14),
    });
    try {
      assertCritiqueRateOk(r, NOW);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RebuildCritiqueRateLimitError);
      const e = err as RebuildCritiqueRateLimitError;
      expect(e.retryAfterSeconds).toBeGreaterThanOrEqual(3500);
      expect(e.retryAfterSeconds).toBeLessThanOrEqual(3700);
      expect(e.limit).toBe(CRITIQUE_DAILY_CAP);
    }
  });

  it("CRITIQUE_DAILY_CAP is 10 (pinned by spec)", () => {
    expect(CRITIQUE_DAILY_CAP).toBe(10);
  });
});
