/**
 * Tests for the bulletproof analysis layer.
 *
 * Two surfaces under test, both critical to the user-visible
 * guarantee that "the analysis screen never shows the misleading
 * `Analysis didn't complete` panel when the input was actually
 * recoverable":
 *
 *   1. `buildFallbackReport(args, reason)` — produces a Report
 *      that ALWAYS satisfies `reportSchema`, for every round
 *      type, for every failure reason. We pin schema validation
 *      end-to-end so a future schema tightening (e.g. raising
 *      `strengths.min(1)` to `min(2)`) doesn't silently break
 *      the fallback path.
 *
 *   2. `isThinTranscript(t)` — the gate that decides "should we
 *      short-circuit the LLM call?". We pin the exact thresholds
 *      and the "either bound is sufficient" semantics so a future
 *      threshold tweak makes a deliberate, code-review-visible
 *      change.
 *
 *   3. `sanitizeReportInput(parsed)` — the salvage step that
 *      backfills empty/missing required fields BEFORE Zod runs.
 *      Pinned for the 2026-05-18 incident pattern: a thin
 *      transcript made the LLM emit `strengths: []` /
 *      `improvements: []`, which crashed schema validation and
 *      sent the user to the failed-panel. With the new
 *      backfill, the same response now produces a valid report.
 */
import { describe, expect, it } from "vitest";

import {
  buildFallbackReport,
  FALLBACK_MODEL_VERSION_PREFIX,
  isThinTranscript,
  reportSchema,
  sanitizeReportInput,
  THIN_TRANSCRIPT_MIN_SECONDS,
  THIN_TRANSCRIPT_MIN_WORDS,
  type AnalyzeArgs,
  type FallbackReason,
} from "@/lib/llm";

const baseArgs = (
  roundType: AnalyzeArgs["session"]["roundType"] = "behavioral",
): AnalyzeArgs => ({
  session: {
    companyName: "Apple",
    roleTitle: "SQL Data Analyst",
    level: "mid",
    roundType,
  },
  transcript: {
    redactedText: "transcript",
    editedText: null,
    wordCount: 2,
    durationSeconds: 2,
    fillerWordCount: 0,
  },
  artifacts: [],
});

describe("buildFallbackReport — every reason and round type validates", () => {
  const reasons: FallbackReason[] = [
    "thin_transcript",
    "llm_validation_failed",
    "llm_unavailable",
    "llm_error",
  ];
  const rounds: AnalyzeArgs["session"]["roundType"][] = [
    "coding",
    "system_design",
    "behavioral",
    "other",
  ];

  // The cartesian product is small (4 × 4 = 16) and the assertion
  // is the load-bearing one for the entire feature: every fallback
  // report MUST satisfy `reportSchema`. If even ONE combination
  // failed validation, the analyze worker would still hit the
  // failed-panel path under that combination.
  for (const reason of reasons) {
    for (const round of rounds) {
      it(`reason=${reason} round=${round} produces a schema-valid Report`, () => {
        const result = buildFallbackReport(baseArgs(round), reason);
        const parsed = reportSchema.safeParse(result.report);
        if (!parsed.success) {
          throw new Error(
            `fallback report failed schema for reason=${reason} round=${round}: ${parsed.error.message}`,
          );
        }
        expect(parsed.success).toBe(true);
      });
    }
  }

  it("stamps modelVersion with the FALLBACK prefix + the reason", () => {
    const result = buildFallbackReport(baseArgs(), "thin_transcript");
    expect(result.modelVersion).toBe(`${FALLBACK_MODEL_VERSION_PREFIX}thin_transcript`);
  });

  it("returns at least one strength and at least one improvement (schema mins)", () => {
    const result = buildFallbackReport(baseArgs(), "llm_error");
    expect(result.report.strengths.length).toBeGreaterThanOrEqual(1);
    expect(result.report.improvements.length).toBeGreaterThanOrEqual(1);
  });

  it("emits an empty questionsCovered array (no fabricated questions)", () => {
    const result = buildFallbackReport(baseArgs(), "thin_transcript");
    expect(result.report.questionsCovered).toEqual([]);
  });

  it("does NOT emit per_question_analytics (renderer hides the section)", () => {
    const result = buildFallbackReport(baseArgs(), "thin_transcript");
    expect(result.report.per_question_analytics).toBeUndefined();
  });

  it("thin-transcript copy mentions the duration and word count for clarity", () => {
    const args = baseArgs();
    args.transcript.wordCount = 3;
    args.transcript.durationSeconds = 2;
    const result = buildFallbackReport(args, "thin_transcript");
    // The user-facing copy must surface the actual numbers so the
    // candidate knows what to fix. Pin both substrings — a future
    // copy edit that drops them is a UX regression.
    expect(result.report.executiveSummary).toContain("2s");
    expect(result.report.executiveSummary).toContain("3 word");
  });

  it("uses singular 'word' (not 'words') when wordCount === 1", () => {
    const args = baseArgs();
    args.transcript.wordCount = 1;
    args.transcript.durationSeconds = 1;
    const result = buildFallbackReport(args, "thin_transcript");
    expect(result.report.executiveSummary).toMatch(/1 word(?!s)/);
  });

  it("thin-transcript with editedText surfaces the edited word count, not the audio duration", () => {
    // The 2026-05-18 incident edge case: the candidate edited a
    // thin recording but the edit itself was still short. The
    // copy must describe the EDITED text — the user is on the
    // edit screen, not the recorder, and pointing them at the
    // recording length would be confusing.
    const args = baseArgs();
    args.transcript.wordCount = 3;
    args.transcript.durationSeconds = 3;
    args.transcript.editedText = "five whole words right here.";
    const result = buildFallbackReport(args, "thin_transcript");

    expect(result.report.executiveSummary).toContain("transcript");
    expect(result.report.executiveSummary).toContain("5 word");
    expect(result.report.executiveSummary).not.toContain("3s");
    expect(result.report.executiveSummary).not.toMatch(/recording was/);
    // The action should point the user at the edit screen, not at
    // recording a fresh round.
    expect(result.report.improvements[0]!.action.toLowerCase()).toContain(
      "re-analyze",
    );
  });

  it("non-thin reasons get the generic 're-analyze' copy, not the recording copy", () => {
    const result = buildFallbackReport(baseArgs(), "llm_validation_failed");
    // The two copy paths diverge — make sure the LLM-failure path
    // tells the user to re-analyze (which would fix it) rather
    // than to re-record the round (which wouldn't fix an LLM
    // bug). The thin-transcript path's actionable improvement
    // tells the user to "Start a new session and record the full
    // round" — pin that THIS path's action is different.
    expect(result.report.executiveSummary.toLowerCase()).toContain("re-analyz");
    const improvementAction = result.report.improvements[0]!.action;
    expect(improvementAction.toLowerCase()).toContain("retry");
    expect(improvementAction.toLowerCase()).not.toContain("start a new session");
  });

  it("never points the user at a non-existent dashboard Retry button", () => {
    // Regression guard for the 2026-05 bug: the non-thin fallback
    // copy used to read "Click 'Reset and retry' on the dashboard"
    // — but the dashboard is a list view with no per-session
    // retry control. The actual `RetryButton` is rendered inline
    // on the session report page (via the `FallbackRetryBanner`
    // in [src/app/(app)/sessions/[id]/page.tsx]).
    // This test pins every reason's user-facing copy so a future
    // edit can't silently re-introduce the dead-end reference.
    for (const reason of [
      "llm_validation_failed",
      "llm_unavailable",
      "llm_error",
    ] as const satisfies readonly FallbackReason[]) {
      const result = buildFallbackReport(baseArgs(), reason);
      const surfaces = [
        result.report.executiveSummary,
        result.report.aiRead.paragraph,
        ...result.report.strengths.flatMap((s) => [s.heading, s.detail]),
        ...result.report.improvements.flatMap((i) => [
          i.heading,
          i.detail,
          i.action,
        ]),
      ];
      for (const text of surfaces) {
        expect(text.toLowerCase(), `reason=${reason}`).not.toContain(
          "dashboard",
        );
      }
    }
  });
});

describe("isThinTranscript — boundary semantics", () => {
  it("returns true when wordCount is below the minimum", () => {
    expect(
      isThinTranscript({
        wordCount: THIN_TRANSCRIPT_MIN_WORDS - 1,
        durationSeconds: 600,
      }),
    ).toBe(true);
  });

  it("returns true when durationSeconds is below the minimum", () => {
    expect(
      isThinTranscript({
        wordCount: 500,
        durationSeconds: THIN_TRANSCRIPT_MIN_SECONDS - 1,
      }),
    ).toBe(true);
  });

  it("returns true when BOTH bounds are missed (the common case)", () => {
    expect(isThinTranscript({ wordCount: 2, durationSeconds: 2 })).toBe(true);
  });

  it("returns false when both bounds are exactly at the minimum (inclusive)", () => {
    expect(
      isThinTranscript({
        wordCount: THIN_TRANSCRIPT_MIN_WORDS,
        durationSeconds: THIN_TRANSCRIPT_MIN_SECONDS,
      }),
    ).toBe(false);
  });

  it("returns false for a normal interview-length transcript", () => {
    // 60 minute interview, ~150 wpm → 9000 words / 3600s.
    expect(isThinTranscript({ wordCount: 9000, durationSeconds: 3600 })).toBe(false);
  });

  // The 2026-05-18 incident pattern: a misclick recording (3s,
  // 3 words) is edited up to a real-length transcript before
  // re-analysis. The original audio-derived bounds are stale; the
  // gate must trust the edited text and let it through.
  describe("editedText branch — trust the user's typed text over stale audio bounds", () => {
    it("returns false when editedText is long, even with thin audio counts", () => {
      const longEdit = Array.from({ length: 200 }, () => "word").join(" ");
      expect(
        isThinTranscript({
          wordCount: 3,
          durationSeconds: 3,
          editedText: longEdit,
        }),
      ).toBe(false);
    });

    it("returns true when editedText is below the word minimum", () => {
      expect(
        isThinTranscript({
          wordCount: 9000,
          durationSeconds: 3600,
          editedText: "only a handful of words",
        }),
      ).toBe(true);
    });

    it("returns true when editedText is empty / whitespace-only", () => {
      expect(
        isThinTranscript({
          wordCount: 9000,
          durationSeconds: 3600,
          editedText: "   \n\t  ",
        }),
      ).toBe(true);
    });

    it("ignores durationSeconds entirely when editedText is present", () => {
      // 30 words takes ~12s at 150 wpm, well under the 15s audio
      // bound, but the user explicitly typed those 30 words so the
      // duration is irrelevant.
      const thirtyWords = Array.from({ length: 30 }, () => "word").join(" ");
      expect(
        isThinTranscript({
          wordCount: 3,
          durationSeconds: 3,
          editedText: thirtyWords,
        }),
      ).toBe(false);
    });

    it("falls back to audio-derived bounds when editedText is null", () => {
      // editedText === null is the "user never edited" case; we
      // must continue gating on wordCount/durationSeconds.
      expect(
        isThinTranscript({
          wordCount: 3,
          durationSeconds: 3,
          editedText: null,
        }),
      ).toBe(true);
    });
  });
});

describe("sanitizeReportInput — backfill for sparse LLM responses", () => {
  // The 2026-05-18 incident: a 2-word transcript made the LLM
  // honestly emit `strengths: []` / `improvements: []`. Both are
  // schema-illegal (min(1)), so the analyze worker refunded the
  // user and showed the failed panel. The new backfill should
  // make this response parse cleanly.

  const sparseModelResponse = {
    executiveSummary:
      "The transcript was too short to analyze meaningfully.",
    strengths: [],
    improvements: [],
    communicationSignals: {
      pace: { summary: "n/a — transcript too short" },
      fillerWords: { summary: "n/a — transcript too short", topOffenders: [] },
      structure: { summary: "n/a — transcript too short" },
      presence: { summary: "n/a — transcript too short" },
    },
    roundSpecific: {
      kind: "coding" as const,
      problemFraming: "Couldn't assess — transcript too short.",
      solutionExploration: "Couldn't assess — transcript too short.",
      implementationHygiene: "Couldn't assess — transcript too short.",
      verification: "Couldn't assess — transcript too short.",
      recoveryFromFeedback: "Couldn't assess — transcript too short.",
    },
    aiRead: {
      paragraph: "The transcript was too short to analyze meaningfully.",
    },
    questionsCovered: [],
  };

  it("backfills empty `strengths` so the report validates", () => {
    const cleaned = sanitizeReportInput(sparseModelResponse);
    const parsed = reportSchema.safeParse(cleaned);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.strengths.length).toBeGreaterThanOrEqual(1);
  });

  it("backfills empty `improvements` so the report validates", () => {
    const cleaned = sanitizeReportInput(sparseModelResponse);
    const parsed = reportSchema.safeParse(cleaned);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.improvements.length).toBeGreaterThanOrEqual(1);
  });

  it("backfills missing `executiveSummary` (model omitted the field)", () => {
    const withoutSummary = {
      ...sparseModelResponse,
      executiveSummary: "",
    };
    const cleaned = sanitizeReportInput(withoutSummary);
    const parsed = reportSchema.safeParse(cleaned);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.executiveSummary.length).toBeGreaterThan(0);
  });

  it("leaves a non-empty `strengths` array alone", () => {
    const intact = {
      ...sparseModelResponse,
      strengths: [
        {
          heading: "Clear framing",
          detail: "You laid out the problem before coding.",
          evidence: [],
        },
      ],
    };
    const cleaned = sanitizeReportInput(intact) as typeof intact;
    expect(cleaned.strengths).toHaveLength(1);
    expect(cleaned.strengths[0]!.heading).toBe("Clear framing");
  });

  it("leaves a non-empty `executiveSummary` alone (no clobber)", () => {
    const intact = {
      ...sparseModelResponse,
      executiveSummary:
        "A real, substantive summary the model produced. Should not be touched.",
      strengths: [
        {
          heading: "Anchor",
          detail: "Detail.",
          evidence: [],
        },
      ],
      improvements: [
        {
          heading: "Anchor",
          detail: "Detail.",
          action: "Do the thing.",
          evidence: [],
          rebuildEligible: false,
        },
      ],
    };
    const cleaned = sanitizeReportInput(intact) as typeof intact;
    expect(cleaned.executiveSummary).toBe(intact.executiveSummary);
  });

  it("the cleaned sparse response always satisfies reportSchema (end-to-end)", () => {
    // The headline assertion: an LLM response that ONLY fails Zod
    // because of empty strengths/improvements must now pass.
    const cleaned = sanitizeReportInput(sparseModelResponse);
    const parsed = reportSchema.safeParse(cleaned);
    expect(parsed.success).toBe(true);
  });
});
