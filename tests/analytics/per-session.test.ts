/**
 * Unit tests for the pure aggregation functions over
 * `per_question_analytics`. The Analytics tab (Prompt 3) renders
 * chart data exclusively from these helpers — any drift here
 * changes the user-visible bar widths.
 */
import { describe, expect, it } from "vitest";

import {
  aggregateStarCompleteness,
  classifyAnswerLengths,
  classifySpeechPace,
  computeTimeDistribution,
} from "@/lib/analytics/per-session";
import type { PerQuestionAnalytics } from "@/lib/llm";

const ART = (n: number): string =>
  `${n.toString().padStart(8, "0")}-0000-0000-0000-000000000000`;

const entry = (
  overrides: Partial<PerQuestionAnalytics>,
): PerQuestionAnalytics => ({
  artifact_id: ART(1),
  question_text: "Q",
  duration_seconds: 120,
  question_type: "behavioral",
  star_signals: {
    situation: "present",
    task: "present",
    action: "present",
    result: "present",
  },
  filler_per_minute: 3,
  i_count: 10,
  we_count: 2,
  profile_leverage: { status: "no_match" },
  ...overrides,
});

/* ────────────────────────────────────────────────────────────── */
/* aggregateStarCompleteness                                      */
/* ────────────────────────────────────────────────────────────── */

describe("aggregateStarCompleteness", () => {
  it("returns zeroed totals for an empty array", () => {
    const result = aggregateStarCompleteness([]);
    expect(result.totalScoreable).toBe(0);
    expect(result.situation).toEqual({
      present: 0,
      weak: 0,
      missing: 0,
      total: 0,
    });
  });

  it("counts a single all-present entry as 1/0/0 on every dimension", () => {
    const result = aggregateStarCompleteness([entry({})]);
    expect(result.totalScoreable).toBe(1);
    expect(result.situation).toEqual({
      present: 1,
      weak: 0,
      missing: 0,
      total: 1,
    });
    expect(result.task).toEqual({
      present: 1,
      weak: 0,
      missing: 0,
      total: 1,
    });
    expect(result.action).toEqual({
      present: 1,
      weak: 0,
      missing: 0,
      total: 1,
    });
    expect(result.result).toEqual({
      present: 1,
      weak: 0,
      missing: 0,
      total: 1,
    });
  });

  it("handles a mixed-status case across multiple entries", () => {
    const items = [
      entry({
        artifact_id: ART(1),
        star_signals: {
          situation: "present",
          task: "weak",
          action: "missing",
          result: "missing",
        },
      }),
      entry({
        artifact_id: ART(2),
        star_signals: {
          situation: "present",
          task: "present",
          action: "weak",
          result: "missing",
        },
      }),
      entry({
        artifact_id: ART(3),
        star_signals: {
          situation: "weak",
          task: "missing",
          action: "present",
          result: "present",
        },
      }),
    ];
    const result = aggregateStarCompleteness(items);
    expect(result.totalScoreable).toBe(3);
    expect(result.situation).toEqual({
      present: 2,
      weak: 1,
      missing: 0,
      total: 3,
    });
    expect(result.task).toEqual({
      present: 1,
      weak: 1,
      missing: 1,
      total: 3,
    });
    expect(result.action).toEqual({
      present: 1,
      weak: 1,
      missing: 1,
      total: 3,
    });
    expect(result.result).toEqual({
      present: 1,
      weak: 0,
      missing: 2,
      total: 3,
    });
  });

  it("excludes all-'na' entries from totalScoreable and from every bar", () => {
    const items = [
      entry({
        artifact_id: ART(1),
        question_type: "closing",
        star_signals: {
          situation: "na",
          task: "na",
          action: "na",
          result: "na",
        },
      }),
      entry({
        artifact_id: ART(2),
        question_type: "behavioral",
        star_signals: {
          situation: "present",
          task: "weak",
          action: "missing",
          result: "present",
        },
      }),
    ];
    const result = aggregateStarCompleteness(items);
    expect(result.totalScoreable).toBe(1);
    expect(result.situation.total).toBe(1);
    expect(result.task).toEqual({
      present: 0,
      weak: 1,
      missing: 0,
      total: 1,
    });
  });

  it("handles a partial-'na' entry (counts dimensions that aren't 'na' only)", () => {
    // Not a spec-defined case (closing/clarification get all-'na')
    // but a defensive contract — a future addition that lets the
    // model emit per-dimension 'na' should still produce
    // mathematically-coherent bars.
    const items = [
      entry({
        star_signals: {
          situation: "present",
          task: "na",
          action: "weak",
          result: "missing",
        },
      }),
    ];
    const result = aggregateStarCompleteness(items);
    expect(result.totalScoreable).toBe(1);
    expect(result.situation.total).toBe(1);
    expect(result.task.total).toBe(0);
    expect(result.action.total).toBe(1);
  });
});

/* ────────────────────────────────────────────────────────────── */
/* classifyAnswerLengths                                          */
/* ────────────────────────────────────────────────────────────── */

describe("classifyAnswerLengths", () => {
  it("classifies bands at exact boundaries", () => {
    // < 90 short, 90..180 in_range, > 180 long.
    // Test 60, 89, 90, 91, 120, 179, 180, 181, 240.
    const points = [60, 89, 90, 91, 120, 179, 180, 181, 240];
    const items = points.map((s, i) =>
      entry({ artifact_id: ART(i + 1), duration_seconds: s }),
    );
    const result = classifyAnswerLengths(items);
    expect(result.map((r) => r.band)).toEqual([
      "short", // 60
      "short", // 89
      "in_range", // 90 (inclusive)
      "in_range", // 91
      "in_range", // 120
      "in_range", // 179
      "in_range", // 180 (inclusive)
      "long", // 181
      "long", // 240
    ]);
  });

  it("classifies closing and clarification question types as 'meta' rather than filtering them out", () => {
    // Behavior change (2026-05): the chart now shows ALL questions
    // so the candidate sees every answer they gave, but closing /
    // clarification rows are flagged with the `meta` band so the
    // renderer can paint them neutral and the narrative generator
    // can exclude them from short/long counts.
    const items = [
      entry({ artifact_id: ART(1), question_type: "behavioral" }),
      entry({
        artifact_id: ART(2),
        question_type: "closing",
        duration_seconds: 20,
      }),
      entry({
        artifact_id: ART(3),
        question_type: "clarification",
        duration_seconds: 200,
      }),
      entry({ artifact_id: ART(4), question_type: "technical" }),
    ];
    const result = classifyAnswerLengths(items);
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.artifact_id)).toEqual([
      ART(1),
      ART(2),
      ART(3),
      ART(4),
    ]);
    // Meta classification ignores duration — a 20s closing question
    // is NOT flagged "short", and a 200s clarification is NOT
    // flagged "long".
    expect(result[1]!.band).toBe("meta");
    expect(result[2]!.band).toBe("meta");
  });

  it("preserves the artifact_id and duration_seconds on every classification", () => {
    const item = entry({ artifact_id: ART(42), duration_seconds: 137 });
    const [classified] = classifyAnswerLengths([item]);
    expect(classified).toEqual({
      artifact_id: ART(42),
      duration_seconds: 137,
      band: "in_range",
    });
  });

  it("falls back to a synthetic q-${index} key when artifact_id is missing", () => {
    // The 2026-05-18 prompt revision allows transcript-inferred
    // questions to omit `artifact_id`. The classifier must still
    // produce a stable client-side key on every row so the
    // chart's React `key` prop never collides — synthesize one
    // from the input index so two artifact-less rows never share
    // a key.
    const items = [
      entry({ artifact_id: undefined, duration_seconds: 60 }),
      entry({
        artifact_id: undefined,
        duration_seconds: 60,
        question_type: "closing",
      }),
      entry({ artifact_id: ART(7), duration_seconds: 120 }),
      entry({ artifact_id: undefined, duration_seconds: 200 }),
    ];
    expect(classifyAnswerLengths(items).map((r) => r.artifact_id)).toEqual([
      "q-0",
      "q-1",
      ART(7),
      "q-3",
    ]);
  });
});

/* ────────────────────────────────────────────────────────────── */
/* computeTimeDistribution                                        */
/* ────────────────────────────────────────────────────────────── */

describe("computeTimeDistribution", () => {
  it("returns 0% for every entry when total duration is 0", () => {
    const items = [
      entry({ artifact_id: ART(1), duration_seconds: 0 }),
      entry({ artifact_id: ART(2), duration_seconds: 0 }),
    ];
    expect(computeTimeDistribution(items).every((d) => d.percent === 0)).toBe(
      true,
    );
  });

  it("percentages sum to 100 (modulo float rounding)", () => {
    const items = [
      entry({ artifact_id: ART(1), duration_seconds: 100 }),
      entry({ artifact_id: ART(2), duration_seconds: 200 }),
      entry({ artifact_id: ART(3), duration_seconds: 300 }),
    ];
    const sum = computeTimeDistribution(items).reduce(
      (acc, d) => acc + d.percent,
      0,
    );
    expect(sum).toBeCloseTo(100, 8);
  });

  it("preserves original input order", () => {
    const items = [
      entry({ artifact_id: ART(1), duration_seconds: 500 }),
      entry({ artifact_id: ART(2), duration_seconds: 100 }),
      entry({ artifact_id: ART(3), duration_seconds: 200 }),
    ];
    expect(computeTimeDistribution(items).map((d) => d.artifact_id)).toEqual([
      ART(1),
      ART(2),
      ART(3),
    ]);
  });

  it("includes ALL question types (closing/clarification not filtered)", () => {
    const items = [
      entry({ artifact_id: ART(1), question_type: "behavioral" }),
      entry({ artifact_id: ART(2), question_type: "closing" }),
    ];
    expect(computeTimeDistribution(items)).toHaveLength(2);
  });

  it("falls back to a synthetic q-${index} key when artifact_id is missing", () => {
    // Mirrors the classifyAnswerLengths fallback so chart segments
    // always have a unique React key. computeTimeDistribution does
    // NOT filter rows, so the synthetic index always matches the
    // array index directly.
    const items = [
      entry({ artifact_id: undefined, duration_seconds: 100 }),
      entry({ artifact_id: ART(2), duration_seconds: 200 }),
      entry({ artifact_id: undefined, duration_seconds: 300 }),
    ];
    expect(computeTimeDistribution(items).map((d) => d.artifact_id)).toEqual([
      "q-0",
      ART(2),
      "q-2",
    ]);
  });

  it("falls back to synthetic keys even when total duration is 0 (degenerate zero-duration case)", () => {
    const items = [
      entry({ artifact_id: undefined, duration_seconds: 0 }),
      entry({ artifact_id: undefined, duration_seconds: 0 }),
    ];
    const out = computeTimeDistribution(items);
    expect(out.map((d) => d.artifact_id)).toEqual(["q-0", "q-1"]);
    expect(out.every((d) => d.percent === 0)).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────── */
/* classifySpeechPace                                             */
/* ────────────────────────────────────────────────────────────── */

describe("classifySpeechPace", () => {
  it("classifies measured / conversational / brisk at boundaries", () => {
    // < 120 measured, 120..170 conversational, > 170 brisk.
    // Test 99, 100, 119, 120, 170, 171, 200, 201.
    expect(classifySpeechPace(99)).toBe("measured");
    expect(classifySpeechPace(100)).toBe("measured"); // still < 120
    expect(classifySpeechPace(119)).toBe("measured");
    expect(classifySpeechPace(120)).toBe("conversational");
    expect(classifySpeechPace(170)).toBe("conversational");
    expect(classifySpeechPace(171)).toBe("brisk");
    expect(classifySpeechPace(200)).toBe("brisk");
    expect(classifySpeechPace(201)).toBe("brisk");
  });

  it("returns 'measured' for 0 wpm (defensive edge — no speech)", () => {
    expect(classifySpeechPace(0)).toBe("measured");
  });
});
