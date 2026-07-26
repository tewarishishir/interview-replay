/**
 * Tests for the report Zod schema + the placeholder report
 * generator. The placeholder is what the analyze worker writes
 * when no LLM backend is configured in dev — it must satisfy the
 * same schema we render against, otherwise the report page
 * crashes for dev-mode users.
 *
 * The schema test covers each round-specific kind so a future
 * rubric tweak that adds a required field doesn't silently miss
 * a kind in the discriminated union.
 */
import { describe, expect, it } from "vitest";

import {
  buildPlaceholderReport,
  containsForbiddenLanguage,
  improvementSchema,
  questionCoveredSchema,
  reportSchema,
  SYSTEM_PROMPT,
} from "@/lib/llm";
import type { AnalyzeArgs, QuestionCovered } from "@/lib/llm";

const baseArgs = (
  roundType: "coding" | "system_design" | "behavioral" | "other",
): AnalyzeArgs => ({
  session: {
    companyName: "Stripe",
    roleTitle: "Senior Backend Engineer",
    level: "senior",
    roundType,
  },
  transcript: {
    redactedText: "ok",
    editedText: null,
    wordCount: 100,
    durationSeconds: 600,
    fillerWordCount: 5,
  },
  artifacts: [],
});

describe("buildPlaceholderReport", () => {
  for (const round of [
    "coding",
    "system_design",
    "behavioral",
    "other",
  ] as const) {
    it(`produces a schema-valid placeholder for ${round}`, () => {
      const result = buildPlaceholderReport(baseArgs(round));
      const validated = reportSchema.safeParse(result.report);
      expect(validated.success).toBe(true);
      expect(result.report.roundSpecific.kind).toBe(round);
      expect(result.modelVersion).toBe("placeholder");
      expect(result.rubricVersion).toBeTruthy();
    });

    it(`${round} placeholder body does NOT contain pass/fail language`, () => {
      const result = buildPlaceholderReport(baseArgs(round));
      const flat = JSON.stringify(result.report);
      expect(containsForbiddenLanguage(flat)).toBe(false);
    });
  }
});

describe("reportSchema — discriminated union on roundSpecific", () => {
  it("rejects an unknown roundSpecific.kind", () => {
    const placeholder = buildPlaceholderReport(baseArgs("coding"));
    const broken = {
      ...placeholder.report,
      roundSpecific: { kind: "interview", foo: "bar" },
    };
    expect(reportSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a coding roundSpecific missing required fields", () => {
    const placeholder = buildPlaceholderReport(baseArgs("coding"));
    const broken = {
      ...placeholder.report,
      roundSpecific: { kind: "coding", problemFraming: "..." },
    };
    expect(reportSchema.safeParse(broken).success).toBe(false);
  });

  it("requires at least one strength and at least one improvement", () => {
    const placeholder = buildPlaceholderReport(baseArgs("coding"));
    expect(
      reportSchema.safeParse({ ...placeholder.report, strengths: [] }).success,
    ).toBe(false);
    expect(
      reportSchema.safeParse({ ...placeholder.report, improvements: [] }).success,
    ).toBe(false);
  });

  it("rejects an executiveSummary longer than 1200 chars", () => {
    const placeholder = buildPlaceholderReport(baseArgs("coding"));
    const broken = {
      ...placeholder.report,
      executiveSummary: "a".repeat(1201),
    };
    expect(reportSchema.safeParse(broken).success).toBe(false);
  });
});

describe("reportSchema — questionsCovered", () => {
  // The questionsCovered list is the load-bearing fix for "the
  // upstream Haiku review pass returned zero suggestions, so the
  // candidate had no question list at all". Sonnet always populates
  // it from the transcript + artifacts; the schema enforces shape
  // and bounds so a runaway model can't pad the report.

  const validQuestion: QuestionCovered = {
    question: "Tell me about yourself.",
    confidence: "high",
    source: "transcript_inferred",
    evidenceQuote: "I am a senior data engineering manager...",
  };

  it("accepts the placeholder report's questionsCovered shape", () => {
    const placeholder = buildPlaceholderReport(baseArgs("behavioral"));
    expect(Array.isArray(placeholder.report.questionsCovered)).toBe(true);
    expect(placeholder.report.questionsCovered.length).toBeGreaterThan(0);
    const validated = reportSchema.safeParse(placeholder.report);
    expect(validated.success).toBe(true);
  });

  it("defaults questionsCovered to [] when the field is omitted (legacy reports)", () => {
    // Legacy reports persisted before the field was introduced still
    // need to validate — render-side hides the section when empty.
    const placeholder = buildPlaceholderReport(baseArgs("coding"));
    const { questionsCovered, ...withoutField } = placeholder.report;
    void questionsCovered;
    const validated = reportSchema.safeParse(withoutField);
    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.data.questionsCovered).toEqual([]);
    }
  });

  it("accepts an explicitly empty questionsCovered array", () => {
    // The prompt instructs the model to emit [] when no question is
    // identifiable rather than fabricating; the schema must allow it.
    const placeholder = buildPlaceholderReport(baseArgs("coding"));
    const report = { ...placeholder.report, questionsCovered: [] };
    expect(reportSchema.safeParse(report).success).toBe(true);
  });

  it("accepts a fully-populated questionsCovered list (high/medium/low + both sources)", () => {
    const placeholder = buildPlaceholderReport(baseArgs("behavioral"));
    const report = {
      ...placeholder.report,
      questionsCovered: [
        {
          question: "Tell me about yourself.",
          confidence: "high",
          source: "candidate_confirmed",
        },
        {
          question: "Why our company?",
          confidence: "medium",
          source: "transcript_inferred",
          evidenceQuote: "I really like the culture here...",
        },
        {
          question: "Maybe a follow-up about scaling?",
          confidence: "low",
          source: "transcript_inferred",
        },
      ],
    };
    expect(reportSchema.safeParse(report).success).toBe(true);
  });

  it("rejects an unknown confidence band", () => {
    const broken = { ...validQuestion, confidence: "unknown" as never };
    expect(questionCoveredSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an unknown source tag", () => {
    // 'ai_inferred' is the artifact-table source enum — but on the
    // report side we collapse it under either 'candidate_confirmed'
    // (if the candidate confirmed/edited it) or 'transcript_inferred'
    // (if Sonnet is making the guess fresh). Anything else is the
    // model inventing a tag and must be rejected so the renderer's
    // pill switch stays exhaustive.
    const broken = { ...validQuestion, source: "ai_inferred" as never };
    expect(questionCoveredSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a question string longer than 500 chars", () => {
    const broken = { ...validQuestion, question: "x".repeat(501) };
    expect(questionCoveredSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an evidenceQuote longer than 500 chars", () => {
    const broken = { ...validQuestion, evidenceQuote: "x".repeat(501) };
    expect(questionCoveredSchema.safeParse(broken).success).toBe(false);
  });

  it("treats evidenceQuote as optional (a candidate_confirmed row may have none)", () => {
    const minimal = {
      question: "Tell me about yourself.",
      confidence: "high" as const,
      source: "candidate_confirmed" as const,
    };
    expect(questionCoveredSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects more than 30 questions in a single report", () => {
    const placeholder = buildPlaceholderReport(baseArgs("coding"));
    const overflowing = {
      ...placeholder.report,
      questionsCovered: Array.from({ length: 31 }, (_, i) => ({
        question: `Question ${i + 1}?`,
        confidence: "medium" as const,
        source: "transcript_inferred" as const,
      })),
    };
    expect(reportSchema.safeParse(overflowing).success).toBe(false);
  });
});

/**
 * `rebuildEligible` is the per-improvement flag the model sets so
 * the report view can render an inline "Rebuild a story for this →"
 * button under exactly the right cards (no more bottom-of-report
 * "Strengthen your story bank" duplication).
 *
 * The schema contract has two load-bearing properties:
 *
 *   1. New reports MUST be able to carry true/false explicitly so
 *      the analyzer can communicate intent.
 *
 *   2. Legacy reports persisted before the field was introduced
 *      MUST still parse — Option A in the rebuild-refactor spec is
 *      "no backfill, the field defaults to false on legacy data so
 *      old reports surface no inline button". The default is the
 *      single source of truth that lets us remove the bottom
 *      section without breaking historic report pages.
 */
describe("improvementSchema — rebuildEligible (Option A: legacy reports default to false)", () => {
  const baseImprovement = {
    heading: "Tighten the Result on your migration story",
    detail: "You wrapped without naming the metric you moved.",
    action:
      "Add the before/after number for the metric you owned in your STAR Result.",
    evidence: [],
  };

  it("accepts rebuildEligible: true (analyzer marks a story-shape gap)", () => {
    const parsed = improvementSchema.safeParse({
      ...baseImprovement,
      rebuildEligible: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.rebuildEligible).toBe(true);
  });

  it("accepts rebuildEligible: false (analyzer marks a delivery / pacing improvement)", () => {
    const parsed = improvementSchema.safeParse({
      ...baseImprovement,
      rebuildEligible: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.rebuildEligible).toBe(false);
  });

  it("defaults rebuildEligible to false when the field is absent (legacy report path)", () => {
    // Pre-refactor improvements were `{heading, detail, action,
    // evidence}` only. Those rows MUST still parse so the report
    // page doesn't 500 on historic data — and the default MUST be
    // false so they don't surface a wrong rebuild button.
    const parsed = improvementSchema.safeParse(baseImprovement);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.rebuildEligible).toBe(false);
  });

  it("rejects non-boolean values (the inline button gate is a strict-equality check downstream)", () => {
    expect(
      improvementSchema.safeParse({
        ...baseImprovement,
        rebuildEligible: "yes",
      }).success,
    ).toBe(false);
    expect(
      improvementSchema.safeParse({
        ...baseImprovement,
        rebuildEligible: 1,
      }).success,
    ).toBe(false);
    expect(
      improvementSchema.safeParse({
        ...baseImprovement,
        rebuildEligible: null,
      }).success,
    ).toBe(false);
  });

  it("a full report with mixed rebuildEligible values round-trips", () => {
    const placeholder = buildPlaceholderReport(baseArgs("behavioral"));
    const report = {
      ...placeholder.report,
      improvements: [
        { ...baseImprovement, rebuildEligible: true },
        {
          heading: "Slow your speaking pace in the second half",
          detail: "You ramped from ~140 wpm to ~210 wpm.",
          action: "Practice a 60-second story at conversational pace.",
          evidence: [],
          rebuildEligible: false,
        },
        { ...baseImprovement, rebuildEligible: true },
      ],
    };
    const parsed = reportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.improvements.map((m) => m.rebuildEligible)).toEqual([
        true,
        false,
        true,
      ]);
    }
  });

  it("placeholder report's improvement is rebuildEligible: false (operational guidance, not a story-shape gap)", () => {
    const placeholder = buildPlaceholderReport(baseArgs("behavioral"));
    expect(placeholder.report.improvements).toHaveLength(1);
    expect(placeholder.report.improvements[0]?.rebuildEligible).toBe(false);
  });
});

describe("SYSTEM_PROMPT — rebuildEligible instructions reach the model", () => {
  // The prompt is the load-bearing source of truth for what
  // rebuildEligible MEANS to the analyzer. If it stops mentioning
  // the field, the LLM stops emitting it, the schema defaults
  // every improvement to false, and the inline button silently
  // disappears across every new report. Pin the contract here so
  // a future prompt edit can't drop the section silently.
  it("instructs the model to set rebuildEligible per improvement", () => {
    expect(SYSTEM_PROMPT).toContain("rebuildEligible");
  });

  it("calls out the structural-gap criteria (STAR / ownership / quantification)", () => {
    expect(SYSTEM_PROMPT).toMatch(/STAR/i);
    expect(SYSTEM_PROMPT).toMatch(/quantification/i);
    expect(SYSTEM_PROMPT).toMatch(/ownership/i);
  });

  it("calls out the delivery-only false cases (pacing / fillers / delivery)", () => {
    expect(SYSTEM_PROMPT).toMatch(/pacing/i);
    expect(SYSTEM_PROMPT).toMatch(/filler/i);
    expect(SYSTEM_PROMPT).toMatch(/delivery/i);
  });

  it("caps the count at 2-4 per report so the section doesn't drown the candidate", () => {
    // Spec calls for "2-4 rebuild_eligible items per report" — pin
    // the number so a future re-write that drops it gets caught.
    expect(SYSTEM_PROMPT).toMatch(/2-4/);
  });

  it("includes rebuildEligible in the JSON example so the model has a concrete shape to copy", () => {
    expect(SYSTEM_PROMPT).toMatch(/"rebuildEligible"/);
  });
});

describe("SYSTEM_PROMPT — aiRead vs executiveSummary differentiation", () => {
  it("includes the differentiation section header", () => {
    // v4 renamed the section to be explicit about direction
    expect(SYSTEM_PROMPT).toContain("InterviewReplay'ed read vs. Executive Summary");
  });

  it("instructs the model to run the hard differentiation test", () => {
    // v4 promotes this to a top-level === block for emphasis
    expect(SYSTEM_PROMPT).toMatch(/HARD DIFFERENTIATION TEST/i);
  });

  it("describes executiveSummary as the full diagnostic landscape", () => {
    // v4 describes exec summary as covering the full landscape, not just a mode label
    expect(SYSTEM_PROMPT).toContain("full diagnostic landscape");
  });

  it("describes aiRead as the single most important takeaway", () => {
    // v4 frames aiRead as the SINGLE MOST IMPORTANT takeaway, not just a mode label
    expect(SYSTEM_PROMPT).toContain("SINGLE MOST IMPORTANT takeaway");
  });

  it("carries a sentence-level check instruction for aiRead", () => {
    // The check asks the model to verify no sentence could be moved
    // verbatim into executiveSummary.
    expect(SYSTEM_PROMPT).toMatch(/could this sentence.*executiveSummary/is);
  });
});
