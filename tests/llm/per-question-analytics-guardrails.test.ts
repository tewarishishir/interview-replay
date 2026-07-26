/**
 * Tests for the four post-response guardrails over
 * `per_question_analytics`. Each guardrail emits a distinct warning
 * via console.warn; we spy on it so we can assert each event fires
 * at the right time.
 *
 * The guardrail layer is pure modulo the console.warn side-effect,
 * so these tests don't need the DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

import {
  ANALYTICS_GUARDRAIL_EVENTS,
  runAnalyticsGuardrails,
} from "@/lib/analytics/per-session-guardrails";
import type { PerQuestionAnalytics } from "@/lib/llm";

const ARTIFACT_A = "11111111-1111-1111-1111-111111111111";
const ARTIFACT_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_A = "33333333-3333-3333-3333-333333333333";
const STORY_A = "44444444-4444-4444-4444-444444444444";
const BAD_UUID = "deadbeef-dead-dead-dead-deadbeefdead";

const baseEntry = (
  overrides: Partial<PerQuestionAnalytics> = {},
): PerQuestionAnalytics => ({
  artifact_id: ARTIFACT_A,
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

beforeEach(() => {
  warnSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAnalyticsGuardrails — base cases", () => {
  it("passes a clean array through unchanged", () => {
    const result = runAnalyticsGuardrails({
      entries: [baseEntry(), baseEntry({ artifact_id: ARTIFACT_B })],
      validArtifactIds: new Set([ARTIFACT_A, ARTIFACT_B]),
      validProjectIds: new Set(),
      validStoryIds: new Set(),
      transcriptDurationSeconds: 240,
    });
    expect(result.failures).toHaveLength(0);
    expect(result.entries).toHaveLength(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns an empty array unchanged", () => {
    const result = runAnalyticsGuardrails({
      entries: [],
      validArtifactIds: new Set(),
      validProjectIds: new Set(),
      validStoryIds: new Set(),
      transcriptDurationSeconds: 600,
    });
    expect(result.entries).toEqual([]);
    expect(result.failures).toEqual([]);
  });
});

describe("Guardrail 1 — hallucinated referenced_item_id", () => {
  // Each single-entry test uses transcriptDurationSeconds === the
  // entry's duration so guardrail 4 doesn't double-fire and inflate
  // the expected failure count.
  it("resets profile_leverage to no_match when referenced_item_id doesn't exist", () => {
    const entry = baseEntry({
      profile_leverage: {
        status: "used",
        referenced_item_type: "project",
        referenced_item_id: BAD_UUID,
        referenced_item_label: "Faked project",
      },
    });
    const result = runAnalyticsGuardrails({
      entries: [entry],
      validArtifactIds: new Set([ARTIFACT_A]),
      validProjectIds: new Set([PROJECT_A]),
      validStoryIds: new Set([STORY_A]),
      transcriptDurationSeconds: 120,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.profile_leverage).toEqual({ status: "no_match" });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.event).toBe(
      ANALYTICS_GUARDRAIL_EVENTS.hallucinatedReferencedItem,
    );
  });

  it("emits the correct warning", () => {
    const entry = baseEntry({
      profile_leverage: {
        status: "used",
        referenced_item_type: "story",
        referenced_item_id: BAD_UUID,
      },
    });
    runAnalyticsGuardrails({
      entries: [entry],
      validArtifactIds: new Set([ARTIFACT_A]),
      validProjectIds: new Set(),
      validStoryIds: new Set([STORY_A]),
      transcriptDurationSeconds: 120,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("analytics_hallucinated_referenced_item"),
      expect.objectContaining({
        reason: expect.stringContaining("referenced_item_id"),
      }),
    );
  });

  it("accepts a real referenced project id", () => {
    const entry = baseEntry({
      profile_leverage: {
        status: "used",
        referenced_item_type: "project",
        referenced_item_id: PROJECT_A,
        referenced_item_label: "Real project",
      },
    });
    const result = runAnalyticsGuardrails({
      entries: [entry],
      validArtifactIds: new Set([ARTIFACT_A]),
      validProjectIds: new Set([PROJECT_A]),
      validStoryIds: new Set(),
      transcriptDurationSeconds: 120,
    });
    expect(result.entries[0]!.profile_leverage.referenced_item_id).toBe(
      PROJECT_A,
    );
    expect(result.failures).toHaveLength(0);
  });

  it("trips when referenced_item_type=project but id is actually a story", () => {
    const entry = baseEntry({
      profile_leverage: {
        status: "used",
        referenced_item_type: "project",
        referenced_item_id: STORY_A,
      },
    });
    const result = runAnalyticsGuardrails({
      entries: [entry],
      validArtifactIds: new Set([ARTIFACT_A]),
      validProjectIds: new Set([PROJECT_A]),
      validStoryIds: new Set([STORY_A]),
      transcriptDurationSeconds: 120,
    });
    // Story id under a project type → guardrail trips. The
    // reference is genuinely inconsistent.
    expect(result.failures[0]!.event).toBe(
      ANALYTICS_GUARDRAIL_EVENTS.hallucinatedReferencedItem,
    );
  });
});

describe("Guardrail 2 — hallucinated suggested_item_id", () => {
  it("resets profile_leverage to no_match when suggested_item_id doesn't exist", () => {
    const entry = baseEntry({
      profile_leverage: {
        status: "available_unused",
        suggested_item_id: BAD_UUID,
        suggested_item_label: "Faked story",
      },
    });
    const result = runAnalyticsGuardrails({
      entries: [entry],
      validArtifactIds: new Set([ARTIFACT_A]),
      validProjectIds: new Set([PROJECT_A]),
      validStoryIds: new Set([STORY_A]),
      transcriptDurationSeconds: 120,
    });
    expect(result.entries[0]!.profile_leverage).toEqual({ status: "no_match" });
    expect(result.failures[0]!.event).toBe(
      ANALYTICS_GUARDRAIL_EVENTS.hallucinatedSuggestedItem,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("analytics_hallucinated_suggested_item"),
      expect.anything(),
    );
  });

  it("accepts a real suggested story id (matches stories pool)", () => {
    const entry = baseEntry({
      profile_leverage: {
        status: "available_unused",
        suggested_item_id: STORY_A,
        suggested_item_label: "Real story",
      },
    });
    const result = runAnalyticsGuardrails({
      entries: [entry],
      validArtifactIds: new Set([ARTIFACT_A]),
      validProjectIds: new Set(),
      validStoryIds: new Set([STORY_A]),
      transcriptDurationSeconds: 120,
    });
    expect(result.entries[0]!.profile_leverage.suggested_item_id).toBe(STORY_A);
    expect(result.failures).toHaveLength(0);
  });
});

describe("Guardrail 3 — invalid artifact_id", () => {
  it("drops the entry when artifact_id doesn't exist on the session", () => {
    const result = runAnalyticsGuardrails({
      entries: [
        baseEntry({ artifact_id: ARTIFACT_A }),
        baseEntry({ artifact_id: BAD_UUID }),
        baseEntry({ artifact_id: ARTIFACT_B }),
      ],
      validArtifactIds: new Set([ARTIFACT_A, ARTIFACT_B]),
      validProjectIds: new Set(),
      validStoryIds: new Set(),
      transcriptDurationSeconds: 360,
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.artifact_id)).toEqual([
      ARTIFACT_A,
      ARTIFACT_B,
    ]);
    expect(result.failures.find((f) => f.event === ANALYTICS_GUARDRAIL_EVENTS.invalidArtifactId)).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("analytics_invalid_artifact_id"),
      expect.anything(),
    );
  });

  it("preserves order when dropping entries", () => {
    const result = runAnalyticsGuardrails({
      entries: [
        baseEntry({ artifact_id: BAD_UUID, question_text: "first" }),
        baseEntry({ artifact_id: ARTIFACT_A, question_text: "second" }),
      ],
      validArtifactIds: new Set([ARTIFACT_A]),
      validProjectIds: new Set(),
      validStoryIds: new Set(),
      transcriptDurationSeconds: 240,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.question_text).toBe("second");
  });

  it("keeps entries that have NO artifact_id (transcript-inferred questions)", () => {
    // The 2026-05-18 prompt revision lets the model emit
    // per_question_analytics entries for transcript-inferred
    // questions, which by construction have no backing artifact
    // row. Guardrail 3 must only fire on entries that DO carry
    // an artifact_id and that id is unknown — otherwise the new
    // sourcing rule would systematically drop the very rows the
    // prompt was reworded to produce.
    const result = runAnalyticsGuardrails({
      entries: [
        baseEntry({
          artifact_id: undefined,
          question_text: "transcript-inferred q1",
        }),
        baseEntry({
          artifact_id: ARTIFACT_A,
          question_text: "artifact-backed q2",
        }),
        baseEntry({
          artifact_id: undefined,
          question_text: "transcript-inferred q3",
        }),
      ],
      validArtifactIds: new Set([ARTIFACT_A]),
      validProjectIds: new Set(),
      validStoryIds: new Set(),
      transcriptDurationSeconds: 360,
    });
    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((e) => e.question_text)).toEqual([
      "transcript-inferred q1",
      "artifact-backed q2",
      "transcript-inferred q3",
    ]);
    expect(
      result.failures.find(
        (f) => f.event === ANALYTICS_GUARDRAIL_EVENTS.invalidArtifactId,
      ),
    ).toBeUndefined();
  });
});

describe("Guardrail 4 — duration mismatch", () => {
  it("logs a warning when duration sum is < 80% of transcript", () => {
    const result = runAnalyticsGuardrails({
      // Two entries totaling 100s vs. a 600s transcript = 16.7% (way under 80%)
      entries: [
        baseEntry({ duration_seconds: 50 }),
        baseEntry({ artifact_id: ARTIFACT_B, duration_seconds: 50 }),
      ],
      validArtifactIds: new Set([ARTIFACT_A, ARTIFACT_B]),
      validProjectIds: new Set(),
      validStoryIds: new Set(),
      transcriptDurationSeconds: 600,
    });
    expect(result.entries).toHaveLength(2); // NOT rejected
    expect(
      result.failures.find(
        (f) => f.event === ANALYTICS_GUARDRAIL_EVENTS.durationMismatch,
      ),
    ).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("analytics_duration_mismatch"),
      expect.anything(),
    );
  });

  it("logs a warning when duration sum is > 120% of transcript", () => {
    const result = runAnalyticsGuardrails({
      entries: [
        baseEntry({ duration_seconds: 800 }),
      ],
      validArtifactIds: new Set([ARTIFACT_A]),
      validProjectIds: new Set(),
      validStoryIds: new Set(),
      transcriptDurationSeconds: 600,
    });
    expect(result.entries).toHaveLength(1);
    expect(
      result.failures.find(
        (f) => f.event === ANALYTICS_GUARDRAIL_EVENTS.durationMismatch,
      ),
    ).toBeDefined();
  });

  it("passes when duration sum is inside the 80%-120% band", () => {
    const result = runAnalyticsGuardrails({
      // 600s total vs. 600s transcript = 100%
      entries: [
        baseEntry({ duration_seconds: 300 }),
        baseEntry({ artifact_id: ARTIFACT_B, duration_seconds: 300 }),
      ],
      validArtifactIds: new Set([ARTIFACT_A, ARTIFACT_B]),
      validProjectIds: new Set(),
      validStoryIds: new Set(),
      transcriptDurationSeconds: 600,
    });
    expect(result.failures.find(
      (f) => f.event === ANALYTICS_GUARDRAIL_EVENTS.durationMismatch,
    )).toBeUndefined();
  });

  it("does not log a mismatch when the entries array is empty after drops", () => {
    const result = runAnalyticsGuardrails({
      // All entries get dropped by guardrail 3; guardrail 4 should
      // skip the duration check rather than report "0 vs. 600".
      entries: [baseEntry({ artifact_id: BAD_UUID, duration_seconds: 100 })],
      validArtifactIds: new Set([ARTIFACT_A]),
      validProjectIds: new Set(),
      validStoryIds: new Set(),
      transcriptDurationSeconds: 600,
    });
    expect(result.entries).toHaveLength(0);
    expect(
      result.failures.find(
        (f) => f.event === ANALYTICS_GUARDRAIL_EVENTS.durationMismatch,
      ),
    ).toBeUndefined();
  });
});

describe("Composite scenarios", () => {
  it("trips both guardrails 1 and 4 on one entry without losing the row", () => {
    const result = runAnalyticsGuardrails({
      entries: [
        baseEntry({
          duration_seconds: 50,
          profile_leverage: {
            status: "used",
            referenced_item_type: "project",
            referenced_item_id: BAD_UUID,
          },
        }),
      ],
      validArtifactIds: new Set([ARTIFACT_A]),
      validProjectIds: new Set([PROJECT_A]),
      validStoryIds: new Set(),
      transcriptDurationSeconds: 600,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.profile_leverage).toEqual({ status: "no_match" });
    expect(result.failures.map((f) => f.event)).toEqual(
      expect.arrayContaining([
        ANALYTICS_GUARDRAIL_EVENTS.hallucinatedReferencedItem,
        ANALYTICS_GUARDRAIL_EVENTS.durationMismatch,
      ]),
    );
  });
});
