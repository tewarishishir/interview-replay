/**
 * Unit tests for the analytics tab's narrative generators. The
 * load-bearing contract:
 *
 *   - Each generator returns a string OR null in the cases the
 *     spec calls out — drift here changes what the user reads
 *     under each chart.
 *   - The pace narrative NEVER contains the words "slow" or
 *     "fast" — the Analytics tab is a coaching surface and we use
 *     descriptive ("measured", "brisk") not judgmental terms.
 */
import { describe, expect, it } from "vitest";

import {
  generateLengthNarrative,
  generatePaceNarrative,
  generateStarNarrative,
  generateTimeDistributionNarrative,
} from "@/lib/analytics/narratives";
import type {
  AnswerLengthClassification,
  StarCompleteness,
  TimeDistributionEntry,
} from "@/lib/analytics/per-session";

const ART = (n: number): string =>
  `${n.toString().padStart(8, "0")}-0000-0000-0000-000000000000`;

/* ────────────────────────────────────────────────────────────── */
/* generateStarNarrative                                          */
/* ────────────────────────────────────────────────────────────── */

const star = (
  partial: Partial<StarCompleteness>,
): StarCompleteness => ({
  situation: { present: 0, weak: 0, missing: 0, total: 0 },
  task: { present: 0, weak: 0, missing: 0, total: 0 },
  action: { present: 0, weak: 0, missing: 0, total: 0 },
  result: { present: 0, weak: 0, missing: 0, total: 0 },
  totalScoreable: 0,
  ...partial,
});

describe("generateStarNarrative", () => {
  it("returns null when every dimension is fully present", () => {
    const data = star({
      situation: { present: 5, weak: 0, missing: 0, total: 5 },
      task: { present: 5, weak: 0, missing: 0, total: 5 },
      action: { present: 5, weak: 0, missing: 0, total: 5 },
      result: { present: 5, weak: 0, missing: 0, total: 5 },
      totalScoreable: 5,
    });
    expect(generateStarNarrative(data)).toBeNull();
  });

  it("identifies the weakest dimension when missing_pct >= 30", () => {
    const data = star({
      situation: { present: 4, weak: 0, missing: 1, total: 5 },
      task: { present: 4, weak: 0, missing: 1, total: 5 },
      action: { present: 4, weak: 0, missing: 1, total: 5 },
      result: { present: 1, weak: 0, missing: 4, total: 5 },
      totalScoreable: 5,
    });
    const narrative = generateStarNarrative(data);
    expect(narrative).not.toBeNull();
    expect(narrative).toContain("Result");
    expect(narrative).toContain("quantified outcome");
    expect(narrative).toContain("80%");
  });

  it("uses 'situation' wording for the situation dimension", () => {
    const data = star({
      situation: { present: 0, weak: 0, missing: 5, total: 5 },
      task: { present: 5, weak: 0, missing: 0, total: 5 },
      action: { present: 5, weak: 0, missing: 0, total: 5 },
      result: { present: 5, weak: 0, missing: 0, total: 5 },
      totalScoreable: 5,
    });
    const narrative = generateStarNarrative(data);
    expect(narrative).toContain("Situation");
    expect(narrative).toContain("without a situation");
  });

  it("uses 'clear task' wording for the task dimension", () => {
    const data = star({
      situation: { present: 5, weak: 0, missing: 0, total: 5 },
      task: { present: 0, weak: 0, missing: 5, total: 5 },
      action: { present: 5, weak: 0, missing: 0, total: 5 },
      result: { present: 5, weak: 0, missing: 0, total: 5 },
      totalScoreable: 5,
    });
    expect(generateStarNarrative(data)).toContain("clear task");
  });

  it("uses 'concrete action' wording for the action dimension", () => {
    const data = star({
      situation: { present: 5, weak: 0, missing: 0, total: 5 },
      task: { present: 5, weak: 0, missing: 0, total: 5 },
      action: { present: 0, weak: 0, missing: 5, total: 5 },
      result: { present: 5, weak: 0, missing: 0, total: 5 },
      totalScoreable: 5,
    });
    expect(generateStarNarrative(data)).toContain("concrete action");
  });

  it("returns 'underdeveloped' phrasing when weak_pct >= 40 but missing_pct < 30", () => {
    const data = star({
      situation: { present: 5, weak: 0, missing: 0, total: 5 },
      task: { present: 5, weak: 0, missing: 0, total: 5 },
      action: { present: 1, weak: 3, missing: 1, total: 5 }, // weak 60%, missing 20%
      result: { present: 5, weak: 0, missing: 0, total: 5 },
      totalScoreable: 5,
    });
    const narrative = generateStarNarrative(data);
    expect(narrative).not.toBeNull();
    expect(narrative).toContain("underdeveloped");
    expect(narrative).toContain("Action");
  });

  it("returns null when no dimension is weak enough", () => {
    const data = star({
      situation: { present: 4, weak: 1, missing: 0, total: 5 },
      task: { present: 4, weak: 1, missing: 0, total: 5 },
      action: { present: 4, weak: 1, missing: 0, total: 5 },
      result: { present: 4, weak: 1, missing: 0, total: 5 },
      totalScoreable: 5,
    });
    expect(generateStarNarrative(data)).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────── */
/* generateLengthNarrative                                        */
/* ────────────────────────────────────────────────────────────── */

const length = (
  band: "short" | "in_range" | "long",
  durationSeconds: number,
  artifactId: string,
): AnswerLengthClassification => ({
  artifact_id: artifactId,
  duration_seconds: durationSeconds,
  band,
});

describe("generateLengthNarrative", () => {
  it("returns null on an empty array", () => {
    expect(generateLengthNarrative([])).toBeNull();
  });

  it("emits the outliers narrative when >= 2 long answers exist", () => {
    const items = [
      length("long", 240, ART(1)),
      length("long", 300, ART(2)),
      length("in_range", 120, ART(3)),
    ];
    const narrative = generateLengthNarrative(items);
    expect(narrative).not.toBeNull();
    expect(narrative).toMatch(/longer than 5 minutes/);
    expect(narrative).toMatch(/2–3 minutes per answer/);
  });

  it("emits the outliers narrative when >= 2 short answers exist", () => {
    const items = [
      length("short", 30, ART(1)),
      length("short", 45, ART(2)),
      length("in_range", 120, ART(3)),
    ];
    const narrative = generateLengthNarrative(items);
    expect(narrative).not.toBeNull();
    expect(narrative).toContain("under a minute");
  });

  it("emits the single-long narrative when there's exactly one long and many in-range", () => {
    const items = [
      length("in_range", 120, ART(1)),
      length("long", 260, ART(2)), // Q2 → 4:20
      length("in_range", 130, ART(3)),
      length("in_range", 150, ART(4)),
    ];
    const narrative = generateLengthNarrative(items);
    expect(narrative).not.toBeNull();
    expect(narrative).toContain("Q2");
    expect(narrative).toContain("4:20");
    expect(narrative).toContain("target range");
  });

  it("emits the all-in-range narrative when every answer is in_range", () => {
    const items = [
      length("in_range", 100, ART(1)),
      length("in_range", 120, ART(2)),
      length("in_range", 160, ART(3)),
    ];
    expect(generateLengthNarrative(items)).toContain(
      "All answers landed in the target range",
    );
  });

  it("returns null on a mixed-but-not-pattern distribution (1 long + 1 short + 0 in_range)", () => {
    const items = [
      length("long", 300, ART(1)),
      length("short", 50, ART(2)),
    ];
    expect(generateLengthNarrative(items)).toBeNull();
  });

  it("excludes `meta` entries from short/long counts and the 'all in range' praise", () => {
    // Two meta (closing/clarification) entries that would otherwise
    // be miscounted as "short" if the narrative didn't filter them
    // out. The remaining gradable answers are all in range → the
    // narrative should still emit the strong-discipline praise.
    const items: AnswerLengthClassification[] = [
      length("in_range", 100, ART(1)),
      length("in_range", 150, ART(2)),
      { artifact_id: ART(3), duration_seconds: 20, band: "meta" },
      { artifact_id: ART(4), duration_seconds: 25, band: "meta" },
    ];
    expect(generateLengthNarrative(items)).toContain(
      "All answers landed in the target range",
    );
  });

  it("returns null when every entry is `meta` (no gradable answers)", () => {
    const items: AnswerLengthClassification[] = [
      { artifact_id: ART(1), duration_seconds: 20, band: "meta" },
      { artifact_id: ART(2), duration_seconds: 30, band: "meta" },
    ];
    expect(generateLengthNarrative(items)).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────── */
/* generateTimeDistributionNarrative                              */
/* ────────────────────────────────────────────────────────────── */

const dist = (
  artifactId: string,
  durationSeconds: number,
  percent: number,
): TimeDistributionEntry => ({
  artifact_id: artifactId,
  duration_seconds: durationSeconds,
  percent,
});

describe("generateTimeDistributionNarrative", () => {
  it("emits the top-2 narrative when both > 25% and combined > 40%", () => {
    const items = [
      dist(ART(1), 180, 15),
      dist(ART(2), 360, 30), // top
      dist(ART(3), 120, 10),
      dist(ART(4), 340, 28), // second
      dist(ART(5), 200, 17),
    ];
    const narrative = generateTimeDistributionNarrative(items);
    expect(narrative).toContain("Q2");
    expect(narrative).toContain("Q4");
    expect(narrative).toContain("58%");
    expect(narrative).toContain("longer than");
  });

  it("emits the top-1 narrative when only the top exceeds 25%", () => {
    const items = [
      dist(ART(1), 100, 10),
      dist(ART(2), 350, 35),
      dist(ART(3), 150, 15),
      dist(ART(4), 200, 20),
      dist(ART(5), 200, 20),
    ];
    const narrative = generateTimeDistributionNarrative(items);
    expect(narrative).toContain("Q2");
    expect(narrative).toContain("35%");
    expect(narrative).toContain("significantly more");
  });

  it("emits the even-distribution narrative when no question dominates", () => {
    const items = [
      dist(ART(1), 100, 20),
      dist(ART(2), 100, 20),
      dist(ART(3), 100, 20),
      dist(ART(4), 100, 20),
      dist(ART(5), 100, 20),
    ];
    const narrative = generateTimeDistributionNarrative(items);
    expect(narrative).toBe("Time was distributed relatively evenly across questions.");
  });

  it("falls back to even distribution on an empty array", () => {
    expect(generateTimeDistributionNarrative([])).toBe(
      "Time was distributed relatively evenly across questions.",
    );
  });
});

/* ────────────────────────────────────────────────────────────── */
/* generatePaceNarrative                                          */
/* ────────────────────────────────────────────────────────────── */

describe("generatePaceNarrative", () => {
  it("classifies each WPM band correctly", () => {
    expect(generatePaceNarrative(80)).toContain("Measured pace");
    expect(generatePaceNarrative(110)).toContain("Slightly measured");
    expect(generatePaceNarrative(140)).toContain("Conversational pace");
    expect(generatePaceNarrative(180)).toContain("Brisk pace");
    expect(generatePaceNarrative(220)).toContain("Very brisk");
  });

  it("uses the right band at exact boundaries", () => {
    // < 100, 100..119, 120..170, 171..200, 201..249, >= 250
    expect(generatePaceNarrative(99)).toContain("Measured pace");
    expect(generatePaceNarrative(100)).toContain("Slightly measured");
    expect(generatePaceNarrative(119)).toContain("Slightly measured");
    expect(generatePaceNarrative(120)).toContain("Conversational pace");
    expect(generatePaceNarrative(170)).toContain("Conversational pace");
    expect(generatePaceNarrative(171)).toContain("Brisk pace");
    expect(generatePaceNarrative(200)).toContain("Brisk pace");
    expect(generatePaceNarrative(201)).toContain("Very brisk");
    expect(generatePaceNarrative(249)).toContain("Very brisk");
  });

  // Load-bearing rule from the spec. The Analytics tab is a
  // coaching surface — judgmental words give it the feel of a
  // graded report.
  it("NEVER contains the words 'slow' or 'fast' (judgmental terms)", () => {
    for (const wpm of [50, 80, 99, 100, 119, 120, 145, 170, 171, 185, 200, 201, 249, 250, 300, 343]) {
      const narrative = generatePaceNarrative(wpm);
      const lower = narrative.toLowerCase();
      expect(lower, `WPM ${wpm} narrative should not contain "slow"`).not.toContain("slow");
      expect(lower, `WPM ${wpm} narrative should not contain "fast"`).not.toContain("fast");
    }
  });
});
