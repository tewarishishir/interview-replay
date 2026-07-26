/**
 * Schema tests for the new `per_question_analytics` field on the
 * report response. Pinned here so:
 *
 *   - Reports without the field still parse (legacy + old reports).
 *   - The four guardrail-relevant fields (artifact_id, referenced /
 *     suggested item ids, duration) carry the right types so the
 *     guardrail layer can trust the validated shape.
 *   - The fully-populated happy path round-trips through
 *     `reportSchema` end-to-end.
 *
 * Schema tests only — guardrail behaviour lives in a separate
 * file that hits `runAnalyticsGuardrails` directly.
 */
import { describe, expect, it } from "vitest";

import {
  buildPlaceholderReport,
  perQuestionAnalyticsSchema,
  profileLeverageSchema,
  reportSchema,
  sanitizeReportInput,
  starSignalsSchema,
  type AnalyzeArgs,
  type PerQuestionAnalytics,
} from "@/lib/llm";

const baseArgs = (
  roundType: "coding" | "system_design" | "behavioral" | "other" = "behavioral",
): AnalyzeArgs => ({
  session: {
    companyName: "Stripe",
    roleTitle: "Senior Engineer",
    level: "senior",
    roundType,
  },
  transcript: {
    redactedText: "transcript",
    editedText: null,
    wordCount: 100,
    durationSeconds: 600,
    fillerWordCount: 5,
  },
  artifacts: [],
});

// Valid UUIDv4 strings (zod v4's `z.uuid()` enforces version+variant bits).
const ARTIFACT_UUID = "11111111-1111-4111-8111-111111111111";
const PROJECT_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORY_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const validEntry = (
  overrides: Partial<PerQuestionAnalytics> = {},
): PerQuestionAnalytics => ({
  artifact_id: ARTIFACT_UUID,
  question_text: "Tell me about a time you led a difficult migration.",
  duration_seconds: 150,
  question_type: "behavioral",
  star_signals: {
    situation: "present",
    task: "present",
    action: "weak",
    result: "missing",
  },
  filler_per_minute: 4.2,
  i_count: 14,
  we_count: 6,
  profile_leverage: { status: "no_match" },
  ...overrides,
});

describe("reportSchema — per_question_analytics", () => {
  it("accepts a report with NO per_question_analytics field (legacy reports parse)", () => {
    const placeholder = buildPlaceholderReport(baseArgs()).report;
    expect(placeholder.per_question_analytics).toBeUndefined();
    const result = reportSchema.safeParse(placeholder);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.per_question_analytics).toBeUndefined();
    }
  });

  it("accepts a report with an empty per_question_analytics array", () => {
    const placeholder = buildPlaceholderReport(baseArgs()).report;
    const result = reportSchema.safeParse({
      ...placeholder,
      per_question_analytics: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a fully-populated per_question_analytics entry", () => {
    const entry = validEntry({
      profile_leverage: {
        status: "used",
        referenced_item_type: "project",
        referenced_item_id: PROJECT_UUID,
        referenced_item_label: "Stripe migration project",
      },
    });
    expect(perQuestionAnalyticsSchema.safeParse(entry).success).toBe(true);
  });

  it("rejects an entry with a non-UUID artifact_id", () => {
    const entry = validEntry({ artifact_id: "not-a-uuid" });
    expect(perQuestionAnalyticsSchema.safeParse(entry).success).toBe(false);
  });

  it("accepts an entry with NO artifact_id (transcript-inferred question)", () => {
    // The 2026-05-18 prompt revision lets per_question_analytics
    // entries omit `artifact_id` when the question came from the
    // transcript itself, not from a backing artifact row. Pin the
    // optionality here so a future schema tightening doesn't
    // silently drop those rows again.
    const entry = validEntry({});
    delete (entry as { artifact_id?: string }).artifact_id;
    expect(perQuestionAnalyticsSchema.safeParse(entry).success).toBe(true);
  });

  it("rejects a negative filler_per_minute", () => {
    const entry = validEntry({ filler_per_minute: -1 });
    expect(perQuestionAnalyticsSchema.safeParse(entry).success).toBe(false);
  });

  it("rejects a non-integer duration_seconds", () => {
    const entry = validEntry({ duration_seconds: 12.5 });
    expect(perQuestionAnalyticsSchema.safeParse(entry).success).toBe(false);
  });

  it("rejects a negative duration_seconds", () => {
    const entry = validEntry({ duration_seconds: -10 });
    expect(perQuestionAnalyticsSchema.safeParse(entry).success).toBe(false);
  });

  it("accepts an all-'na' star_signals (closing question shape)", () => {
    const entry = validEntry({
      question_type: "closing",
      star_signals: {
        situation: "na",
        task: "na",
        action: "na",
        result: "na",
      },
    });
    expect(perQuestionAnalyticsSchema.safeParse(entry).success).toBe(true);
  });

  it("rejects an unknown star signal value", () => {
    const broken = {
      situation: "present",
      task: "present",
      action: "great" as never,
      result: "present",
    };
    expect(starSignalsSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an unknown question_type", () => {
    const entry = validEntry({
      question_type: "compensation" as never,
    });
    expect(perQuestionAnalyticsSchema.safeParse(entry).success).toBe(false);
  });

  it("rejects an unknown profile_leverage.status", () => {
    const broken = { status: "ambivalent" as never };
    expect(profileLeverageSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts profile_leverage.status='used' with project reference", () => {
    const ok = {
      status: "used" as const,
      referenced_item_type: "project" as const,
      referenced_item_id: PROJECT_UUID,
      referenced_item_label: "Stripe migration",
    };
    expect(profileLeverageSchema.safeParse(ok).success).toBe(true);
  });

  it("accepts profile_leverage.status='available_unused' with suggested item", () => {
    const ok = {
      status: "available_unused" as const,
      suggested_item_id: STORY_UUID,
      suggested_item_label: "leadership-conflict story",
    };
    expect(profileLeverageSchema.safeParse(ok).success).toBe(true);
  });

  it("accepts profile_leverage.status='no_match' alone", () => {
    expect(profileLeverageSchema.safeParse({ status: "no_match" }).success).toBe(
      true,
    );
  });

  it("rejects a profile_leverage with a non-UUID referenced_item_id", () => {
    const broken = {
      status: "used" as const,
      referenced_item_type: "story" as const,
      referenced_item_id: "definitely not a uuid",
    };
    expect(profileLeverageSchema.safeParse(broken).success).toBe(false);
  });

  it("a full report with a per_question_analytics array round-trips through reportSchema", () => {
    const placeholder = buildPlaceholderReport(baseArgs()).report;
    const fullReport = {
      ...placeholder,
      per_question_analytics: [
        validEntry({
          star_signals: {
            situation: "present",
            task: "present",
            action: "present",
            result: "present",
          },
        }),
        validEntry({
          artifact_id: "22222222-2222-4222-8222-222222222222",
          question_type: "closing",
          star_signals: {
            situation: "na",
            task: "na",
            action: "na",
            result: "na",
          },
        }),
      ],
    };
    const parsed = reportSchema.safeParse(fullReport);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.per_question_analytics).toHaveLength(2);
    }
  });
});

describe("sanitizeReportInput — pre-validation salvage", () => {
  // The end-to-end observable behavior we're pinning here: a
  // production response that fails Zod ONLY because of bad
  // per_question_analytics rows must come out of sanitizeReportInput
  // in a shape that DOES pass `reportSchema.safeParse`. The
  // analyze worker depends on this so a hallucinated artifact_id
  // doesn't refund the user's credits when the prose report is fine.

  const goodReport = () => buildPlaceholderReport(baseArgs()).report;

  it("drops entries whose artifact_id is not a valid UUID", () => {
    const input = {
      ...goodReport(),
      per_question_analytics: [
        validEntry({ artifact_id: "not-a-uuid" }),
        validEntry(),
      ],
    };
    const cleaned = sanitizeReportInput(input) as {
      per_question_analytics: PerQuestionAnalytics[];
    };
    expect(cleaned.per_question_analytics).toHaveLength(1);
    expect(cleaned.per_question_analytics[0]!.artifact_id).toBe(ARTIFACT_UUID);
    expect(reportSchema.safeParse(cleaned).success).toBe(true);
  });

  it("strips per_question_analytics entirely when no entry is salvageable", () => {
    const input = {
      ...goodReport(),
      per_question_analytics: [
        validEntry({ artifact_id: "not-a-uuid" }),
        validEntry({ artifact_id: "also-bogus" }),
      ],
    };
    const cleaned = sanitizeReportInput(input) as Record<string, unknown>;
    expect("per_question_analytics" in cleaned).toBe(false);
    expect(reportSchema.safeParse(cleaned).success).toBe(true);
  });

  it("strips per_question_analytics when the field is the wrong shape", () => {
    const input = {
      ...goodReport(),
      // Model returned a string instead of an array — non-recoverable
      // shape; we strip rather than try to interpret.
      per_question_analytics: "I forgot to emit an array sorry",
    };
    const cleaned = sanitizeReportInput(input) as Record<string, unknown>;
    expect("per_question_analytics" in cleaned).toBe(false);
    expect(reportSchema.safeParse(cleaned).success).toBe(true);
  });

  it("truncates a 35-entry array down to the 30-entry schema cap", () => {
    const oversized = Array.from({ length: 35 }, (_, i) =>
      validEntry({
        // Each entry needs a distinct UUIDv4 so dedupe-style logic
        // upstream wouldn't filter them, but the per-entry schema
        // accepts them all individually.
        artifact_id: `${i.toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
      }),
    );
    const input = {
      ...goodReport(),
      per_question_analytics: oversized,
    };
    const cleaned = sanitizeReportInput(input) as {
      per_question_analytics: PerQuestionAnalytics[];
    };
    expect(cleaned.per_question_analytics).toHaveLength(30);
    expect(reportSchema.safeParse(cleaned).success).toBe(true);
  });

  it("is a no-op when per_question_analytics is absent", () => {
    const input = goodReport();
    const cleaned = sanitizeReportInput(input);
    expect(cleaned).toEqual(input);
  });

  it("preserves other top-level fields unchanged", () => {
    const base = goodReport();
    const input = {
      ...base,
      per_question_analytics: [validEntry({ artifact_id: "not-a-uuid" })],
    };
    const cleaned = sanitizeReportInput(input) as Record<string, unknown>;
    expect(cleaned.executiveSummary).toBe(base.executiveSummary);
    expect(cleaned.strengths).toEqual(base.strengths);
    expect(cleaned.improvements).toEqual(base.improvements);
    expect(cleaned.communicationSignals).toEqual(base.communicationSignals);
    expect(cleaned.roundSpecific).toEqual(base.roundSpecific);
    expect(cleaned.aiRead).toEqual(base.aiRead);
  });
});

describe("SYSTEM_PROMPT — per_question_analytics instructions reach the model", () => {
  // Pin that the prompt actually instructs the model on the new
  // section. If a future prompt edit drops the section, the LLM
  // stops emitting the field, validation falls through to the
  // optional default of `undefined`, and the Analytics tab
  // silently goes dark.
  it("references per_question_analytics in the prompt body", async () => {
    const { SYSTEM_PROMPT } = await import("@/lib/llm");
    expect(SYSTEM_PROMPT).toContain("per_question_analytics");
  });

  it("describes the four star_signals values", async () => {
    const { SYSTEM_PROMPT } = await import("@/lib/llm");
    expect(SYSTEM_PROMPT).toContain("present");
    expect(SYSTEM_PROMPT).toContain("weak");
    expect(SYSTEM_PROMPT).toContain("missing");
    expect(SYSTEM_PROMPT).toContain("na");
  });

  it("warns the model not to invent profile UUIDs", async () => {
    const { SYSTEM_PROMPT } = await import("@/lib/llm");
    expect(SYSTEM_PROMPT).toMatch(/NEVER invent project names|hallucinated/);
  });

  it("calls out the three profile_leverage statuses", async () => {
    const { SYSTEM_PROMPT } = await import("@/lib/llm");
    expect(SYSTEM_PROMPT).toContain("used");
    expect(SYSTEM_PROMPT).toContain("available_unused");
    expect(SYSTEM_PROMPT).toContain("no_match");
  });

  it("anchors per_question_analytics to questionsCovered (2026-05-18 sourcing rule)", async () => {
    // The bug behind 2026-05-18.v1: the previous prompt asked for
    // one per_question_analytics entry per ARTIFACT, which meant
    // sessions with only transcript-inferred questions got an
    // empty analytics tab. Pin that the rewritten prompt makes
    // the source-of-truth coupling explicit so a future edit can't
    // silently revert it.
    const { SYSTEM_PROMPT } = await import("@/lib/llm");
    // The prompt lines are joined with newlines, so we match the
    // anchor phrase across an arbitrary whitespace gap.
    expect(SYSTEM_PROMPT).toMatch(
      /every question\s+you emit in `questionsCovered`/,
    );
  });

  it("tells the model artifact_id is OPTIONAL on transcript-inferred entries", async () => {
    // Without an explicit "OPTIONAL" framing here the model
    // historically fabricated UUIDs to satisfy a (perceived)
    // required field — which guardrail 3 then dropped, collapsing
    // the array to empty. Pin the optionality wording.
    const { SYSTEM_PROMPT } = await import("@/lib/llm");
    expect(SYSTEM_PROMPT).toMatch(/`artifact_id` — OPTIONAL/);
    expect(SYSTEM_PROMPT).toMatch(/OMIT the `artifact_id` field/);
  });
});
