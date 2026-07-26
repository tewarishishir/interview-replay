/**
 * Tests for `applyAnalyticsGuardrails` — the worker-side wrapper
 * that bridges a generated `Report` and `runAnalyticsGuardrails`.
 * Pinned here so the analyze worker's step.run callback can't drift.
 */
import { describe, expect, it, vi } from "vitest";


import { applyAnalyticsGuardrails } from "@/job-runner/functions/analyze-session";
import {
  buildPlaceholderReport,
  type AnalyzeArgs,
  type Report,
} from "@/lib/llm";

const baseArgs: AnalyzeArgs = {
  session: {
    companyName: "Acme",
    roleTitle: "Engineer",
    level: "senior",
    roundType: "behavioral",
  },
  transcript: {
    redactedText: "transcript",
    editedText: null,
    wordCount: 100,
    durationSeconds: 600,
    fillerWordCount: 5,
  },
  artifacts: [],
};

const ART_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJ = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const BAD = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function withAnalytics(entries: NonNullable<Report["per_question_analytics"]>): Report {
  return {
    ...buildPlaceholderReport(baseArgs).report,
    per_question_analytics: entries,
  };
}

describe("applyAnalyticsGuardrails", () => {
  it("passes through a report with no per_question_analytics field", () => {
    const placeholder = buildPlaceholderReport(baseArgs).report;
    const result = applyAnalyticsGuardrails({
      report: placeholder,
      artifactIds: [],
      projectIds: [],
      storyIds: [],
      transcriptDurationSeconds: 600,
    });
    expect(result.per_question_analytics).toBeUndefined();
  });

  it("returns the cleaned array on the report when guardrails fire", () => {
    const report = withAnalytics([
      {
        artifact_id: ART_A,
        question_text: "Q1",
        duration_seconds: 240,
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
        profile_leverage: {
          status: "used",
          referenced_item_type: "project",
          referenced_item_id: BAD,
        },
      },
    ]);
    const cleaned = applyAnalyticsGuardrails({
      report,
      artifactIds: [ART_A],
      projectIds: [PROJ],
      storyIds: [],
      transcriptDurationSeconds: 240,
    });
    expect(cleaned.per_question_analytics).toHaveLength(1);
    expect(cleaned.per_question_analytics![0]!.profile_leverage).toEqual({
      status: "no_match",
    });
  });

  it("preserves the rest of the report unchanged when guardrails trip", () => {
    const original = withAnalytics([]);
    const cleaned = applyAnalyticsGuardrails({
      report: original,
      artifactIds: [],
      projectIds: [],
      storyIds: [],
      transcriptDurationSeconds: 600,
    });
    expect(cleaned.executiveSummary).toBe(original.executiveSummary);
    expect(cleaned.strengths).toEqual(original.strengths);
  });
});
