/**
 * Tests for the Analytics-tab helper functions. These power the
 * STAR badge colors, the legend summary strings, the profile-
 * leverage indicator copy, the per-question card's "should the
 * rebuild button show?" decision, and the tab-mount property
 * derivation.
 *
 * Component-rendering tests aren't run here (the project doesn't
 * mount jsdom in vitest); the components themselves are thin
 * wrappers around these pure helpers, so pinning the helpers
 * pins the user-visible behavior.
 */
import { describe, expect, it } from "vitest";

import {
  ANALYTICS_FEATURE_LAUNCHED_AT,
  AI_READ_TLDR_MAX_CHARS,
  ANSWER_LENGTH_LOWER_TARGET_S,
  ANSWER_LENGTH_UPPER_TARGET_S,
  SPEECH_PACE_GAUGE_MAX_VISIBLE_WPM,
  TIME_DISTRIBUTION_ROW_LIST_THRESHOLD,
  buildAiReadTldr,
  buildCoverageLookup,
  computeAnswerLengthBandGeometry,
  computeSpeechPaceGaugeMetrics,
  confidenceDotColor,
  confidenceDotLabel,
  deriveTabMountProperties,
  findCoverageMatch,
  formatMmSs,
  formatProfileLeverage,
  formatStarSummary,
  hasWeakOrMissingStar,
  isAllNa,
  isPostLaunchReport,
  lengthBandColor,
  pickTimeDistributionRenderMode,
  starBadgeStyleFor,
  starLabelFor,
  starLetterFor,
  timeDistributionShadeAt,
} from "@/components/app/report/analytics-utils";
import { SYSTEM_PROMPT_VERSION } from "@/lib/llm";
import type {
  PerQuestionAnalytics,
  ProfileLeverage,
  QuestionCovered,
} from "@/lib/llm";

const ART = (n: number): string =>
  `${n.toString().padStart(8, "0")}-0000-0000-0000-000000000000`;

const entry = (
  overrides: Partial<PerQuestionAnalytics> = {},
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
/* formatMmSs                                                     */
/* ────────────────────────────────────────────────────────────── */

describe("formatMmSs", () => {
  it("pads the seconds to two digits", () => {
    expect(formatMmSs(65)).toBe("1:05");
    expect(formatMmSs(60)).toBe("1:00");
    expect(formatMmSs(0)).toBe("0:00");
  });

  it("floors fractional seconds", () => {
    expect(formatMmSs(65.9)).toBe("1:05");
  });

  it("clamps negative input to 0:00", () => {
    expect(formatMmSs(-3)).toBe("0:00");
  });
});

/* ────────────────────────────────────────────────────────────── */
/* formatStarSummary                                              */
/* ────────────────────────────────────────────────────────────── */

describe("formatStarSummary", () => {
  it("returns an empty string when no entries contributed", () => {
    expect(
      formatStarSummary({ present: 0, weak: 0, missing: 0, total: 0 }),
    ).toBe("");
  });

  it("collapses fully-present to a single segment", () => {
    expect(
      formatStarSummary({ present: 5, weak: 0, missing: 0, total: 5 }),
    ).toBe("100% present");
  });

  it("includes two-segment mixes", () => {
    expect(
      formatStarSummary({ present: 11, weak: 1, missing: 0, total: 12 }),
    ).toBe("92% present, 8% weak");
  });

  it("includes three-segment mixes in fixed order", () => {
    expect(
      formatStarSummary({ present: 5, weak: 3, missing: 2, total: 10 }),
    ).toBe("50% present, 30% weak, 20% missing");
  });

  it("excludes zero segments from the middle of a mix", () => {
    expect(
      formatStarSummary({ present: 8, weak: 0, missing: 2, total: 10 }),
    ).toBe("80% present, 20% missing");
  });
});

/* ────────────────────────────────────────────────────────────── */
/* starBadgeStyleFor + isAllNa + hasWeakOrMissingStar             */
/* ────────────────────────────────────────────────────────────── */

describe("starBadgeStyleFor", () => {
  it("returns the success palette for 'present' with the ✓ glyph", () => {
    const s = starBadgeStyleFor("present");
    expect(s).not.toBeNull();
    expect(s!.glyph).toBe("✓");
    expect(s!.background).toContain("success-bg");
    expect(s!.color).toContain("success-text");
  });

  it("returns the warning palette for 'weak' with the ⚠ glyph", () => {
    const s = starBadgeStyleFor("weak");
    expect(s).not.toBeNull();
    expect(s!.glyph).toBe("⚠");
    expect(s!.background).toContain("warning-bg");
  });

  it("returns the danger palette for 'missing' with the ✗ glyph", () => {
    const s = starBadgeStyleFor("missing");
    expect(s).not.toBeNull();
    expect(s!.glyph).toBe("✗");
    expect(s!.background).toContain("danger-bg");
  });

  it("returns null for 'na' so the caller can omit the badge", () => {
    expect(starBadgeStyleFor("na")).toBeNull();
  });
});

describe("isAllNa", () => {
  it("is true when every dimension is 'na'", () => {
    expect(
      isAllNa(
        entry({
          star_signals: {
            situation: "na",
            task: "na",
            action: "na",
            result: "na",
          },
        }),
      ),
    ).toBe(true);
  });

  it("is false when any dimension is scored", () => {
    expect(
      isAllNa(
        entry({
          star_signals: {
            situation: "na",
            task: "na",
            action: "weak",
            result: "na",
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("hasWeakOrMissingStar", () => {
  it("is false for all-present", () => {
    expect(hasWeakOrMissingStar(entry({}))).toBe(false);
  });

  it("is true when any dimension is weak", () => {
    expect(
      hasWeakOrMissingStar(
        entry({
          star_signals: {
            situation: "present",
            task: "weak",
            action: "present",
            result: "present",
          },
        }),
      ),
    ).toBe(true);
  });

  it("is true when any dimension is missing", () => {
    expect(
      hasWeakOrMissingStar(
        entry({
          star_signals: {
            situation: "missing",
            task: "present",
            action: "present",
            result: "present",
          },
        }),
      ),
    ).toBe(true);
  });

  it("is false for an all-'na' entry (no signal at all)", () => {
    expect(
      hasWeakOrMissingStar(
        entry({
          star_signals: {
            situation: "na",
            task: "na",
            action: "na",
            result: "na",
          },
        }),
      ),
    ).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────── */
/* starLetterFor + starLabelFor                                   */
/* ────────────────────────────────────────────────────────────── */

describe("starLetterFor / starLabelFor", () => {
  it("uses the S/T/A/R abbreviations on the card badges", () => {
    expect(starLetterFor("situation")).toBe("S");
    expect(starLetterFor("task")).toBe("T");
    expect(starLetterFor("action")).toBe("A");
    expect(starLetterFor("result")).toBe("R");
  });

  it("uses the long-form labels on the bar chart rows", () => {
    expect(starLabelFor("situation")).toBe("Situation");
    expect(starLabelFor("task")).toBe("Task");
    expect(starLabelFor("action")).toBe("Action");
    expect(starLabelFor("result")).toBe("Result");
  });
});

/* ────────────────────────────────────────────────────────────── */
/* lengthBandColor + timeDistributionShadeAt                      */
/* ────────────────────────────────────────────────────────────── */

describe("lengthBandColor", () => {
  it("maps in_range → success, short → warning, long → danger", () => {
    expect(lengthBandColor("in_range")).toBe("var(--color-success)");
    expect(lengthBandColor("short")).toBe("var(--color-warning)");
    expect(lengthBandColor("long")).toBe("var(--color-danger)");
  });

  it("paints `meta` (closing / clarification) in a neutral tertiary tone", () => {
    // Closing / clarification questions aren't graded against the
    // 90-180s target — the chart renders them in a muted color so
    // the eye doesn't read them as outliers.
    expect(lengthBandColor("meta")).toBe("var(--color-text-tertiary)");
  });
});

describe("timeDistributionShadeAt", () => {
  it("alternates between the two purple shades by index parity", () => {
    expect(timeDistributionShadeAt(0)).toBe("#7F77DD");
    expect(timeDistributionShadeAt(1)).toBe("#AFA9EC");
    expect(timeDistributionShadeAt(2)).toBe("#7F77DD");
    expect(timeDistributionShadeAt(3)).toBe("#AFA9EC");
  });

  it("produces different shades for every adjacent pair", () => {
    const colors = Array.from({ length: 8 }, (_, i) =>
      timeDistributionShadeAt(i),
    );
    for (let i = 0; i < colors.length - 1; i++) {
      expect(colors[i]).not.toBe(colors[i + 1]);
    }
  });
});

/* ────────────────────────────────────────────────────────────── */
/* formatProfileLeverage                                          */
/* ────────────────────────────────────────────────────────────── */

describe("formatProfileLeverage", () => {
  it("renders 'used' with success color and is not clickable", () => {
    const lev: ProfileLeverage = {
      status: "used",
      referenced_item_type: "story",
      referenced_item_id: ART(7),
      referenced_item_label: "Backend migration story",
    };
    const ind = formatProfileLeverage(lev);
    expect(ind).not.toBeNull();
    expect(ind!.text).toBe("Used Backend migration story");
    expect(ind!.color).toBe("var(--color-success)");
    expect(ind!.clickable).toBe(false);
  });

  it("renders 'available_unused' with danger color and clickable when a suggested id exists", () => {
    const lev: ProfileLeverage = {
      status: "available_unused",
      referenced_item_type: "story",
      suggested_item_id: ART(11),
      suggested_item_label: "Cross-team migration",
    };
    const ind = formatProfileLeverage(lev);
    expect(ind).not.toBeNull();
    expect(ind!.text).toBe(
      "Stronger story available: Cross-team migration",
    );
    expect(ind!.color).toBe("var(--color-danger)");
    expect(ind!.clickable).toBe(true);
    expect(ind!.suggestedItemId).toBe(ART(11));
  });

  it("uses 'project' noun for available_unused when referenced_item_type is project", () => {
    const lev: ProfileLeverage = {
      status: "available_unused",
      referenced_item_type: "project",
      suggested_item_id: ART(12),
      suggested_item_label: "Order management v2",
    };
    expect(formatProfileLeverage(lev)!.text).toBe(
      "Stronger project available: Order management v2",
    );
  });

  it("falls back to the 'story' noun when referenced_item_type is missing", () => {
    const lev: ProfileLeverage = {
      status: "available_unused",
      suggested_item_id: ART(13),
      suggested_item_label: "Hiring loop redesign",
    };
    expect(formatProfileLeverage(lev)!.text).toBe(
      "Stronger story available: Hiring loop redesign",
    );
  });

  it("'available_unused' without a suggested_item_id is not clickable", () => {
    const lev: ProfileLeverage = {
      status: "available_unused",
      suggested_item_label: "Some option",
    };
    expect(formatProfileLeverage(lev)!.clickable).toBe(false);
  });

  it("renders 'no_match' with the tertiary text color and is not clickable", () => {
    const ind = formatProfileLeverage({ status: "no_match" });
    expect(ind).not.toBeNull();
    expect(ind!.text).toBe("No matching profile content");
    expect(ind!.color).toBe("var(--color-text-tertiary)");
    expect(ind!.clickable).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────── */
/* deriveTabMountProperties                                       */
/* ────────────────────────────────────────────────────────────── */

describe("deriveTabMountProperties", () => {
  it("returns zero counts and false flags for an empty array", () => {
    expect(deriveTabMountProperties([])).toEqual({
      question_count: 0,
      has_profile_leverage_suggestions: false,
      has_weak_star_signals: false,
    });
  });

  it("counts the number of entries", () => {
    expect(deriveTabMountProperties([entry({}), entry({}), entry({})])).toEqual(
      {
        question_count: 3,
        has_profile_leverage_suggestions: false,
        has_weak_star_signals: false,
      },
    );
  });

  it("flips has_profile_leverage_suggestions when any entry is available_unused", () => {
    const items = [
      entry({ profile_leverage: { status: "no_match" } }),
      entry({
        profile_leverage: {
          status: "available_unused",
          suggested_item_id: ART(1),
          suggested_item_label: "x",
        },
      }),
    ];
    expect(deriveTabMountProperties(items).has_profile_leverage_suggestions).toBe(
      true,
    );
  });

  it("does NOT flip has_profile_leverage_suggestions for 'used' status", () => {
    const items = [
      entry({
        profile_leverage: {
          status: "used",
          referenced_item_type: "story",
          referenced_item_id: ART(1),
          referenced_item_label: "x",
        },
      }),
    ];
    expect(deriveTabMountProperties(items).has_profile_leverage_suggestions).toBe(
      false,
    );
  });

  it("flips has_weak_star_signals when any scoreable entry has weak or missing", () => {
    const items = [
      entry({}),
      entry({
        star_signals: {
          situation: "present",
          task: "missing",
          action: "present",
          result: "present",
        },
      }),
    ];
    expect(deriveTabMountProperties(items).has_weak_star_signals).toBe(true);
  });

  it("does NOT flip has_weak_star_signals for all-'na' entries", () => {
    const items = [
      entry({
        star_signals: {
          situation: "na",
          task: "na",
          action: "na",
          result: "na",
        },
      }),
    ];
    expect(deriveTabMountProperties(items).has_weak_star_signals).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────── */
/* ANALYTICS_FEATURE_LAUNCHED_AT + isPostLaunchReport             */
/* ────────────────────────────────────────────────────────────── */

describe("ANALYTICS_FEATURE_LAUNCHED_AT", () => {
  it("matches the date in the prompt's SYSTEM_PROMPT_VERSION", () => {
    // The cutoff exists to decide whether a missing
    // `per_question_analytics` field on a report is "legacy"
    // (prompt section didn't exist yet) or "the LLM ran the new
    // prompt and chose to omit". If the constant drifts away from
    // the prompt bump date, the Analytics tab's copy will lie:
    // pre-launch reports would be told "we couldn't compute
    // analytics" (no, your prompt never asked), and post-launch
    // reports would be told "click re-analyze to populate"
    // (re-analyze won't help — same prompt, same outcome).
    //
    // Encode the version → date mapping here so a prompt bump that
    // forgets to update the constant fails this test loudly.
    expect(SYSTEM_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\./);
    const [datePart] = SYSTEM_PROMPT_VERSION.split(".");
    expect(ANALYTICS_FEATURE_LAUNCHED_AT.toISOString()).toBe(
      `${datePart}T00:00:00.000Z`,
    );
  });
});

describe("isPostLaunchReport", () => {
  it("is false when the date is null (Storybook / harness)", () => {
    expect(isPostLaunchReport(null)).toBe(false);
  });

  it("is false when the date is undefined", () => {
    expect(isPostLaunchReport(undefined)).toBe(false);
  });

  it("is false for a report created the day before the cutoff", () => {
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(
      isPostLaunchReport(
        new Date(ANALYTICS_FEATURE_LAUNCHED_AT.getTime() - oneDayMs),
      ),
    ).toBe(false);
  });

  it("is true at the exact cutoff instant (inclusive boundary)", () => {
    expect(
      isPostLaunchReport(new Date(ANALYTICS_FEATURE_LAUNCHED_AT.getTime())),
    ).toBe(true);
  });

  it("is true for a report created after the cutoff", () => {
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(
      isPostLaunchReport(
        new Date(ANALYTICS_FEATURE_LAUNCHED_AT.getTime() + oneDayMs),
      ),
    ).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────── */
/* computeSpeechPaceGaugeMetrics                                  */
/* ────────────────────────────────────────────────────────────── */

describe("computeSpeechPaceGaugeMetrics", () => {
  it("returns null when wordCount is zero", () => {
    expect(computeSpeechPaceGaugeMetrics(0, 600)).toBeNull();
  });

  it("returns null when durationSeconds is zero", () => {
    expect(computeSpeechPaceGaugeMetrics(1500, 0)).toBeNull();
  });

  it("returns null when both inputs are zero", () => {
    expect(computeSpeechPaceGaugeMetrics(0, 0)).toBeNull();
  });

  it("rounds wpm to the nearest integer", () => {
    // 100 words / 0.5 minutes = 200 wpm exact
    expect(computeSpeechPaceGaugeMetrics(100, 30)!.wpm).toBe(200);
    // 145 words / 1 minute = 145 wpm; needle landing inside the
    // conversational band.
    expect(computeSpeechPaceGaugeMetrics(145, 60)!.wpm).toBe(145);
    // Banker's vs half-up doesn't matter here — both 145.5 → 146.
    // Pick a value with a clear non-integer division to pin the
    // rounding direction.
    expect(computeSpeechPaceGaugeMetrics(133, 60)!.wpm).toBe(133);
  });

  it("clamps visibleWpm to [0, 220] without altering the reported wpm (within plausible range)", () => {
    // Mid-range: 120 wpm exact → conversational band boundary,
    // needle at exactly -90 + (120/220)*180 ≈ -1.818°.
    const mid = computeSpeechPaceGaugeMetrics(120, 60)!;
    expect(mid.wpm).toBe(120);
    expect(mid.visibleWpm).toBe(120);
    expect(mid.angleDegrees).toBeCloseTo(-90 + (120 / 220) * 180, 5);

    // Max visible needle (220 wpm) is within plausible range.
    const atCap = computeSpeechPaceGaugeMetrics(220, 60)!;
    expect(atCap.wpm).toBe(220);
    expect(atCap.visibleWpm).toBe(SPEECH_PACE_GAUGE_MAX_VISIBLE_WPM);
    expect(atCap.angleDegrees).toBe(90);

    // 499 wpm: just under the implausible ceiling — still renders.
    const nearCeiling = computeSpeechPaceGaugeMetrics(499, 60)!;
    expect(nearCeiling).not.toBeNull();
    expect(nearCeiling.wpm).toBe(499);
  });

  it("returns null for physiologically impossible WPM (> 500) — corrupted data guard", () => {
    // 600 wpm: above SPEECH_PACE_MAX_PLAUSIBLE_WPM — suppress the gauge.
    expect(computeSpeechPaceGaugeMetrics(600, 60)).toBeNull();
    // 1000 wpm: same.
    expect(computeSpeechPaceGaugeMetrics(1000, 60)).toBeNull();
    // 25956 wpm: the real-world bug (6,489-word edited transcript / 15s audio).
    expect(computeSpeechPaceGaugeMetrics(6489, 15)).toBeNull();
  });

  it("interpolates the angle linearly from -90° (0 wpm) to +90° (220 wpm)", () => {
    expect(computeSpeechPaceGaugeMetrics(1, 60)!.angleDegrees).toBeCloseTo(
      -90 + (1 / 220) * 180,
      5,
    );
    expect(
      computeSpeechPaceGaugeMetrics(110, 60)!.angleDegrees,
    ).toBeCloseTo(0, 5);
    expect(computeSpeechPaceGaugeMetrics(220, 60)!.angleDegrees).toBe(90);
  });

  it("treats negative inputs as 'no signal' (defensive)", () => {
    // The pipeline never produces negative durations / counts, but
    // a corrupt row or a future migration mistake shouldn't make
    // the gauge render an inverted needle.
    expect(computeSpeechPaceGaugeMetrics(-50, 60)).toBeNull();
    expect(computeSpeechPaceGaugeMetrics(100, -60)).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────── */
/* buildCoverageLookup / findCoverageMatch                        */
/* ────────────────────────────────────────────────────────────── */

const coverage = (
  overrides: Partial<QuestionCovered> = {},
): QuestionCovered => ({
  question: "Tell me about a time you led a project.",
  confidence: "high",
  source: "candidate_confirmed",
  ...overrides,
});

describe("buildCoverageLookup", () => {
  it("returns null when the input is undefined (older reports)", () => {
    expect(buildCoverageLookup(undefined)).toBeNull();
  });

  it("returns null when the input is empty (no questions identified)", () => {
    expect(buildCoverageLookup([])).toBeNull();
  });

  it("indexes each row by its normalised question text", () => {
    const lookup = buildCoverageLookup([
      coverage({ question: "What is your greatest weakness?" }),
      coverage({
        question: "Tell me about a time you led a project.",
        confidence: "medium",
      }),
    ]);
    expect(lookup).not.toBeNull();
    expect(lookup!.size).toBe(2);
    expect(lookup!.get("what is your greatest weakness?")?.confidence).toBe(
      "high",
    );
    expect(
      lookup!.get("tell me about a time you led a project.")?.confidence,
    ).toBe("medium");
  });

  it("keeps the first entry on a normalised-key collision (stable render)", () => {
    // Two entries that only differ in whitespace / casing normalise
    // to the same key. The first one wins so the Analytics card
    // doesn't flip its pill between renders.
    const lookup = buildCoverageLookup([
      coverage({ question: "How do you handle conflict?", confidence: "high" }),
      coverage({
        question: "  How do you HANDLE conflict?  ",
        confidence: "low",
      }),
    ]);
    expect(lookup!.size).toBe(1);
    expect(lookup!.get("how do you handle conflict?")?.confidence).toBe(
      "high",
    );
  });
});

describe("findCoverageMatch", () => {
  const lookup = buildCoverageLookup([
    coverage({
      question: "Tell me about a time you led a project.",
      confidence: "high",
      source: "candidate_confirmed",
    }),
    coverage({
      question: "Why are you leaving your current role?",
      confidence: "low",
      source: "transcript_inferred",
    }),
  ]);

  it("returns null when the lookup is null (no coverage available)", () => {
    expect(
      findCoverageMatch(
        entry({ question_text: "Tell me about a time you led a project." }),
        null,
      ),
    ).toBeNull();
  });

  it("resolves an exact question-text match", () => {
    const match = findCoverageMatch(
      entry({ question_text: "Tell me about a time you led a project." }),
      lookup,
    );
    expect(match?.confidence).toBe("high");
    expect(match?.source).toBe("candidate_confirmed");
  });

  it("ignores casing and surrounding whitespace differences", () => {
    // The schema duplicates `question_text` from the artifact for
    // convenience, but the model occasionally normalises casing or
    // collapses whitespace differently between the two strings.
    // The match must survive those trivial drifts so the pills
    // render reliably on the analytics card.
    const match = findCoverageMatch(
      entry({
        question_text: "  Why are you leaving your CURRENT role?  ",
      }),
      lookup,
    );
    expect(match?.confidence).toBe("low");
    expect(match?.source).toBe("transcript_inferred");
  });

  it("collapses internal whitespace runs before matching", () => {
    // Defensive — a model that emits a double space in one surface
    // and a single space in the other shouldn't cause a mismatch.
    const match = findCoverageMatch(
      entry({
        question_text: "Tell me about a time   you led a project.",
      }),
      lookup,
    );
    expect(match?.confidence).toBe("high");
  });

  it("returns null when no coverage row matches (safer than picking the wrong one)", () => {
    // The card prefers no pills over the wrong pills — a stale or
    // dropped entry shouldn't borrow another question's confidence.
    expect(
      findCoverageMatch(
        entry({ question_text: "What does your ideal team look like?" }),
        lookup,
      ),
    ).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────── */
/* computeAnswerLengthBandGeometry                                */
/* ────────────────────────────────────────────────────────────── */

describe("computeAnswerLengthBandGeometry", () => {
  it("exposes the 90s / 180s anchor constants verbatim", () => {
    // The visual-refinement spec pins these constants explicitly
    // — drifting them silently would move the band away from the
    // 90-180s coaching anchor without updating the legend copy.
    expect(ANSWER_LENGTH_LOWER_TARGET_S).toBe(90);
    expect(ANSWER_LENGTH_UPPER_TARGET_S).toBe(180);
  });

  it("places the band between 37.5% and 75% at max_duration=240s", () => {
    const g = computeAnswerLengthBandGeometry(240);
    expect(g.bottomPct).toBeCloseTo(37.5, 5);
    expect(g.topPct).toBeCloseTo(75, 5);
    expect(g.heightPct).toBeCloseTo(37.5, 5);
  });

  it("clamps the top edge to 100% at max_duration=150s (180s line off-chart)", () => {
    const g = computeAnswerLengthBandGeometry(150);
    expect(g.bottomPct).toBeCloseTo(60, 5);
    expect(g.topPct).toBe(100);
    expect(g.heightPct).toBeCloseTo(40, 5);
  });

  it("places the band from 50% to 100% at max_duration=180s (exact)", () => {
    const g = computeAnswerLengthBandGeometry(180);
    expect(g.bottomPct).toBeCloseTo(50, 5);
    expect(g.topPct).toBe(100);
    expect(g.heightPct).toBeCloseTo(50, 5);
  });

  it("collapses the band to height 0 at max_duration=90s (both edges pinned)", () => {
    const g = computeAnswerLengthBandGeometry(90);
    expect(g.bottomPct).toBe(100);
    expect(g.topPct).toBe(100);
    expect(g.heightPct).toBe(0);
  });

  it("collapses the band to height 0 at max_duration=60s (every answer below target)", () => {
    const g = computeAnswerLengthBandGeometry(60);
    expect(g.bottomPct).toBe(100);
    expect(g.topPct).toBe(100);
    expect(g.heightPct).toBe(0);
  });

  it("places the band at 15%-30% at max_duration=600s (long round)", () => {
    const g = computeAnswerLengthBandGeometry(600);
    expect(g.bottomPct).toBeCloseTo(15, 5);
    expect(g.topPct).toBeCloseTo(30, 5);
    expect(g.heightPct).toBeCloseTo(15, 5);
  });

  it("uses a safe floor of 1s when max_duration <= 0 (defensive)", () => {
    // The analyze pipeline guarantees positive durations but the
    // renderer shouldn't crash on a corrupt row that smuggles a
    // 0 through. Both edges should clamp without exploding.
    const z = computeAnswerLengthBandGeometry(0);
    expect(z.bottomPct).toBe(100);
    expect(z.topPct).toBe(100);
    expect(z.heightPct).toBe(0);
    const n = computeAnswerLengthBandGeometry(-5);
    expect(n.heightPct).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────── */
/* pickTimeDistributionRenderMode                                 */
/* ────────────────────────────────────────────────────────────── */

describe("pickTimeDistributionRenderMode", () => {
  it("pins the spec threshold at 10", () => {
    expect(TIME_DISTRIBUTION_ROW_LIST_THRESHOLD).toBe(10);
  });

  it("renders a stacked bar at the boundary (10 questions)", () => {
    expect(pickTimeDistributionRenderMode(10)).toBe("stacked_bar");
  });

  it("switches to the row list above the threshold (11 questions)", () => {
    expect(pickTimeDistributionRenderMode(11)).toBe("row_list");
  });

  it("renders a stacked bar for small counts (1, 5)", () => {
    expect(pickTimeDistributionRenderMode(1)).toBe("stacked_bar");
    expect(pickTimeDistributionRenderMode(5)).toBe("stacked_bar");
  });

  it("renders a row list for large counts (17, 30)", () => {
    expect(pickTimeDistributionRenderMode(17)).toBe("row_list");
    expect(pickTimeDistributionRenderMode(30)).toBe("row_list");
  });

  it("treats 0 as 'stacked_bar' (the renderer no-ops on empty input anyway)", () => {
    expect(pickTimeDistributionRenderMode(0)).toBe("stacked_bar");
  });
});

/* ────────────────────────────────────────────────────────────── */
/* buildAiReadTldr                                            */
/* ────────────────────────────────────────────────────────────── */

describe("buildAiReadTldr", () => {
  it("pins the 250-character spec cap", () => {
    expect(AI_READ_TLDR_MAX_CHARS).toBe(250);
  });

  it("returns the original paragraph when under the cap", () => {
    const para = "Short and within the cap.";
    expect(buildAiReadTldr(para)).toBe(para);
  });

  it("returns the empty string for empty / whitespace input", () => {
    expect(buildAiReadTldr("")).toBe("");
    expect(buildAiReadTldr("   \n  ")).toBe("");
  });

  it("trims surrounding whitespace before measuring", () => {
    expect(buildAiReadTldr("  hello  ")).toBe("hello");
  });

  it("truncates with ellipsis at a word boundary when one fits in the budget", () => {
    // Pick a paragraph whose nearest word boundary near the cap
    // is well inside the 80% threshold so it gets honoured.
    const sentence =
      "This is the first sentence of the InterviewReplay'ed read and it is going to be long enough that we have to trim it at a word boundary in the middle of the second clause";
    const out = buildAiReadTldr(sentence, 60);
    expect(out.endsWith("…")).toBe(true);
    // The text portion (sans ellipsis) is a prefix of the input.
    const text = out.slice(0, -1).trimEnd();
    expect(sentence.startsWith(text)).toBe(true);
    // Cut landed on a word boundary — the character following
    // the truncation point in the SOURCE is a space (or the
    // string ended).
    const charAfter = sentence.charAt(text.length);
    expect(charAfter === " " || charAfter === "").toBe(true);
  });

  it("falls back to a hard cut when the only space is too close to the start", () => {
    // A single 100-char word at the front and a space near the
    // very end should NOT cause the helper to collapse the
    // teaser to a 5-character preamble. The 80% threshold
    // protects against that.
    const word = "a".repeat(80);
    const para = `${word} tail`;
    const out = buildAiReadTldr(para, 40);
    expect(out.endsWith("…")).toBe(true);
    // Hard cut at 40 chars + ellipsis (no leading word boundary).
    expect(out.length).toBe(41);
  });

  it("respects a custom cap", () => {
    const out = buildAiReadTldr("one two three four five six", 12);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(13); // 12 + ellipsis
  });
});

/* ────────────────────────────────────────────────────────────── */
/* confidenceDotColor / confidenceDotLabel                        */
/* ────────────────────────────────────────────────────────────── */

describe("confidenceDotColor / confidenceDotLabel", () => {
  it("maps high → success token + 'High confidence'", () => {
    expect(confidenceDotColor("high")).toBe("var(--color-success)");
    expect(confidenceDotLabel("high")).toBe("High confidence");
  });

  it("maps medium → warning token + 'Medium confidence'", () => {
    expect(confidenceDotColor("medium")).toBe("var(--color-warning)");
    expect(confidenceDotLabel("medium")).toBe("Medium confidence");
  });

  it("maps low → danger token + 'Low confidence'", () => {
    expect(confidenceDotColor("low")).toBe("var(--color-danger)");
    expect(confidenceDotLabel("low")).toBe("Low confidence");
  });

  it("falls back to the neutral grey + 'Confidence unknown' for null", () => {
    expect(confidenceDotColor(null)).toBe("var(--color-text-tertiary)");
    expect(confidenceDotLabel(null)).toBe("Confidence unknown");
    expect(confidenceDotColor(undefined)).toBe("var(--color-text-tertiary)");
    expect(confidenceDotLabel(undefined)).toBe("Confidence unknown");
  });
});
