/**
 * Unit tests for the bank-surface "AI suggested response" feature.
 *
 * Pure-function-only — no DB, no LLM, no Next.js. The route-level
 * integration tests live alongside this file in
 * `tests/stories/story-suggest-route.test.ts`.
 *
 * Mirrors the rebuild-side `suggest-response.test.ts` posture so
 * the two test surfaces stay structurally similar and a future
 * change can update both in lockstep.
 */
import { describe, expect, it } from "vitest";

import type { Story } from "@/lib/db/schema";
import {
  STORY_SUGGEST_DAILY_CAP,
  StorySuggestRateLimitError,
  assertStorySuggestRateOk,
  countStorySuggestionsInLast24h,
} from "@/lib/stories/rate-gate";

/* ────────────────────────────────────────────────────────────── */
/* Test fixtures                                                  */
/* ────────────────────────────────────────────────────────────── */

const NOW = new Date("2026-05-13T12:00:00Z");
const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

/**
 * Build a Story row with sensible defaults. Every field is
 * overridable so individual tests can pin only the bits they
 * care about.
 */
function story(overrides: Partial<Story> = {}): Story {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    userId: "00000000-0000-0000-0000-000000000099",
    theme: "leadership_conflict",
    title: "Pushed back on a hype-driven AI launch",
    situation: null,
    task: null,
    action: null,
    result: null,
    whatILearned: null,
    aiSuggestedResponseJson: null,
    aiSuggestedResponseModelVersion: null,
    aiSuggestedResponseGeneratedAt: null,
    suggestedResponseHistory: [],
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: NOW,
    ...overrides,
  };
}

/* ────────────────────────────────────────────────────────────── */
/* countStorySuggestionsInLast24h                                 */
/* ────────────────────────────────────────────────────────────── */

describe("countStorySuggestionsInLast24h", () => {
  it("returns 0 for a story with no history and no current suggestion", () => {
    expect(countStorySuggestionsInLast24h(story(), NOW)).toBe(0);
  });

  it("counts the current suggestion when its generated-at is inside the 24h window", () => {
    const s = story({
      aiSuggestedResponseJson: { headline: "x" },
      aiSuggestedResponseGeneratedAt: new Date(NOW.getTime() - 5 * MS_HOUR),
    });
    expect(countStorySuggestionsInLast24h(s, NOW)).toBe(1);
  });

  it("does NOT count the current suggestion when its generated-at is older than 24h", () => {
    const s = story({
      aiSuggestedResponseJson: { headline: "x" },
      aiSuggestedResponseGeneratedAt: new Date(NOW.getTime() - 25 * MS_HOUR),
    });
    expect(countStorySuggestionsInLast24h(s, NOW)).toBe(0);
  });

  it("counts only history entries within the 24h window", () => {
    const s = story({
      suggestedResponseHistory: [
        // out of window — should not count
        { at: new Date(NOW.getTime() - 36 * MS_HOUR).toISOString(), suggestion: {} },
        // in window
        { at: new Date(NOW.getTime() - 12 * MS_HOUR).toISOString(), suggestion: {} },
        { at: new Date(NOW.getTime() - 1 * MS_HOUR).toISOString(), suggestion: {} },
      ],
    });
    expect(countStorySuggestionsInLast24h(s, NOW)).toBe(2);
  });

  it("combines history + current suggestion when both are in window", () => {
    const s = story({
      aiSuggestedResponseJson: { headline: "x" },
      aiSuggestedResponseGeneratedAt: new Date(NOW.getTime() - 1 * MS_HOUR),
      suggestedResponseHistory: [
        { at: new Date(NOW.getTime() - 12 * MS_HOUR).toISOString(), suggestion: {} },
        { at: new Date(NOW.getTime() - 6 * MS_HOUR).toISOString(), suggestion: {} },
      ],
    });
    expect(countStorySuggestionsInLast24h(s, NOW)).toBe(3);
  });

  it("ignores malformed history entries instead of throwing", () => {
    const s = story({
      // Cast through `unknown` — the schema column is jsonb<unknown>,
      // so a corrupted historical row could hold any shape.
      suggestedResponseHistory: [
        null as unknown as { at: string; suggestion: unknown },
        // Missing `at`
        { suggestion: {} } as unknown as { at: string; suggestion: unknown },
        // Non-string `at`
        { at: 123, suggestion: {} } as unknown as { at: string; suggestion: unknown },
        // Unparseable date
        { at: "not-a-date", suggestion: {} },
        // Valid in-window entry
        { at: new Date(NOW.getTime() - 1 * MS_HOUR).toISOString(), suggestion: {} },
      ],
    });
    expect(countStorySuggestionsInLast24h(s, NOW)).toBe(1);
  });

  it("treats a non-array suggestedResponseHistory as empty", () => {
    const s = story({
      suggestedResponseHistory:
        "not-an-array" as unknown as Story["suggestedResponseHistory"],
    });
    expect(countStorySuggestionsInLast24h(s, NOW)).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────── */
/* assertStorySuggestRateOk                                       */
/* ────────────────────────────────────────────────────────────── */

describe("assertStorySuggestRateOk", () => {
  it("returns silently when the count is below the cap", () => {
    const s = story({
      suggestedResponseHistory: Array.from(
        { length: STORY_SUGGEST_DAILY_CAP - 1 },
        (_, i) => ({
          at: new Date(NOW.getTime() - (i + 1) * MS_HOUR).toISOString(),
          suggestion: {},
        }),
      ),
    });
    expect(() => assertStorySuggestRateOk(s, NOW)).not.toThrow();
  });

  it("throws StorySuggestRateLimitError when at the cap", () => {
    const s = story({
      suggestedResponseHistory: Array.from(
        { length: STORY_SUGGEST_DAILY_CAP },
        (_, i) => ({
          at: new Date(NOW.getTime() - (i + 1) * MS_HOUR).toISOString(),
          suggestion: {},
        }),
      ),
    });
    expect(() => assertStorySuggestRateOk(s, NOW)).toThrow(
      StorySuggestRateLimitError,
    );
  });

  it("computes Retry-After from the OLDEST in-window timestamp", () => {
    // Cap reached, oldest entry is exactly 23h ago — retry should be in
    // ~1h (it falls off the back of the window).
    const oldest = new Date(NOW.getTime() - 23 * MS_HOUR);
    const entries = [
      { at: oldest.toISOString(), suggestion: {} },
      ...Array.from({ length: STORY_SUGGEST_DAILY_CAP - 1 }, (_, i) => ({
        at: new Date(NOW.getTime() - (i + 1) * MS_HOUR).toISOString(),
        suggestion: {},
      })),
    ];
    const s = story({ suggestedResponseHistory: entries });
    try {
      assertStorySuggestRateOk(s, NOW);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StorySuggestRateLimitError);
      const e = err as StorySuggestRateLimitError;
      expect(e.limit).toBe(STORY_SUGGEST_DAILY_CAP);
      // Retry-After should be ~1h. Allow a few seconds of fudge for
      // computation overhead in `Math.ceil`.
      expect(e.retryAfterSeconds).toBeGreaterThan(60 * 60 - 5);
      expect(e.retryAfterSeconds).toBeLessThan(60 * 60 + 5);
    }
  });

  it("clamps Retry-After to a positive integer when there are no in-window timestamps", () => {
    // Pathological row: the in-window count somehow >= cap (caller
    // pre-mutated the column?) but no history entry's `at` parses.
    // The defense-in-depth fallback kicks the user back in 1 hour.
    const s = story({
      // 10 unparseable history entries — they don't count toward the
      // window, so the gate doesn't trip from these.
      suggestedResponseHistory: Array.from(
        { length: STORY_SUGGEST_DAILY_CAP },
        () => ({ at: "not-a-date", suggestion: {} }),
      ),
      // ...but mark the current suggestion as having been generated
      // recently with all 10 history entries also being "fresh-ish"
      // via the current-suggestion path.
      aiSuggestedResponseJson: { headline: "x" },
      aiSuggestedResponseGeneratedAt: new Date(NOW.getTime() - 1 * MS_HOUR),
    });
    // Count is 1 (only the current), not at cap — should not throw.
    expect(() => assertStorySuggestRateOk(s, NOW)).not.toThrow();
  });
});

/* ────────────────────────────────────────────────────────────── */
/* Window edge cases — exact 24h boundary                         */
/* ────────────────────────────────────────────────────────────── */

describe("countStorySuggestionsInLast24h — boundary conditions", () => {
  it("counts entries exactly at the 24h boundary", () => {
    // The cutoff is `now - 24h`, and the comparison is `t >= cutoff`.
    // So an entry stamped at exactly 24h ago should be COUNTED, not
    // dropped — defends against off-by-one in the gate when a user
    // hits "Generate" exactly 24 hours after their first.
    const s = story({
      suggestedResponseHistory: [
        { at: new Date(NOW.getTime() - MS_DAY).toISOString(), suggestion: {} },
      ],
    });
    expect(countStorySuggestionsInLast24h(s, NOW)).toBe(1);
  });

  it("does NOT count entries 1ms older than 24h", () => {
    const s = story({
      suggestedResponseHistory: [
        {
          at: new Date(NOW.getTime() - MS_DAY - 1).toISOString(),
          suggestion: {},
        },
      ],
    });
    expect(countStorySuggestionsInLast24h(s, NOW)).toBe(0);
  });
});
