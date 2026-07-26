import "server-only";

import type { PerQuestionAnalytics, ProfileLeverage } from "@/lib/llm";

/**
 * Post-response guardrails for the per_question_analytics array.
 *
 * Runs AFTER Zod validation passes but BEFORE the report is
 * persisted. The four trip-types each emit a distinct event name
 * so trend dashboards can split the failure modes. Each event is
 * fired as a warning-level console.warn so on-call sees the
 * pattern without being paged.
 *
 *   1. `analytics_hallucinated_referenced_item` —
 *      `profile_leverage.referenced_item_id` is a UUID that
 *      doesn't exist in the candidate's `projects` / `stories`.
 *      We reset the whole `profile_leverage` to
 *      `{ status: 'no_match' }` (the load-bearing choice: a
 *      partially-validated leverage object would let a fabricated
 *      label slip into the UI even after the bogus id is dropped).
 *   2. `analytics_hallucinated_suggested_item` — same posture,
 *      but on `suggested_item_id`.
 *   3. `analytics_invalid_artifact_id` — the entry's `artifact_id`
 *      is set but doesn't match any artifact row on the session.
 *      We DROP the entry from the array; there's no meaningful way
 *      to recover a row whose target doesn't exist.
 *      Entries with NO `artifact_id` (transcript-inferred
 *      questions that the prompt now produces — see
 *      `lib/llm/prompt.ts` "Per-question analytics") pass this
 *      guardrail unconditionally; only invalid UUIDs are dropped.
 *   4. `analytics_duration_mismatch` — sum of
 *      `duration_seconds` falls outside 80%-120% of
 *      `transcripts.duration_seconds`. We do NOT reject — the
 *      LLM may have misjudged segment boundaries but the rest of
 *      the analytics are still useful — but we log a warning so
 *      we can trend the model's calibration drift.
 *
 * Asymmetric on purpose: 1/2/3 mutate the array to keep poisoned
 * rows out of `report_json`; 4 only monitors. The function is
 * pure modulo console.warn side-effects so unit tests can hit each
 * branch without spinning up the full analyze pipeline.
 */

export const ANALYTICS_GUARDRAIL_EVENTS = {
  hallucinatedReferencedItem: "analytics_hallucinated_referenced_item",
  hallucinatedSuggestedItem: "analytics_hallucinated_suggested_item",
  invalidArtifactId: "analytics_invalid_artifact_id",
  durationMismatch: "analytics_duration_mismatch",
} as const;

export type AnalyticsGuardrailEvent =
  (typeof ANALYTICS_GUARDRAIL_EVENTS)[keyof typeof ANALYTICS_GUARDRAIL_EVENTS];

export interface AnalyticsGuardrailFailure {
  event: AnalyticsGuardrailEvent;
  /** Human-readable reason; logged for diagnostics, never shown to the user. */
  reason: string;
  /** Index into the ORIGINAL per_question_analytics array. */
  originalIndex?: number;
  /** Artifact UUID involved (when applicable). */
  artifactId?: string;
  /** Profile item UUID involved (when applicable). */
  profileItemId?: string;
}

export interface AnalyticsGuardrailArgs {
  /** The validated per_question_analytics array off the report. */
  entries: ReadonlyArray<PerQuestionAnalytics>;
  /** Set of artifact UUIDs that belong to the session. */
  validArtifactIds: ReadonlySet<string>;
  /** Set of project UUIDs that belong to the candidate. */
  validProjectIds: ReadonlySet<string>;
  /** Set of story UUIDs that belong to the candidate. */
  validStoryIds: ReadonlySet<string>;
  /** Authoritative transcript duration in seconds. */
  transcriptDurationSeconds: number;
  /**
   * Identifying tags for log events. Optional in tests; passed
   * by the worker so a trip can be traced back to a specific
   * session / user.
   */
  logTags?: {
    sessionId?: string;
    userId?: string;
  };
}

export interface AnalyticsGuardrailResult {
  /** Sanitized array — guardrails 1/2 mutated, guardrail 3 dropped. */
  entries: PerQuestionAnalytics[];
  /** Trip records (for tests / further logging). */
  failures: AnalyticsGuardrailFailure[];
}

/**
 * Bounds (inclusive) for guardrail 4 — the per-entry
 * `duration_seconds` sum should fall within this percentage of
 * the transcript's true duration. 80%-120% is a generous band
 * that catches gross miscounts without false-positiving when the
 * candidate's first/last 10 seconds are pre-recording chatter the
 * model omitted from any answer segment.
 */
const DURATION_LOWER_BOUND = 0.8;
const DURATION_UPPER_BOUND = 1.2;

export function runAnalyticsGuardrails(
  args: AnalyticsGuardrailArgs,
): AnalyticsGuardrailResult {
  const failures: AnalyticsGuardrailFailure[] = [];
  const kept: PerQuestionAnalytics[] = [];

  for (let i = 0; i < args.entries.length; i++) {
    const entry = args.entries[i]!;

    /* ── Guardrail 3 first: artifact id consistency ─────────────
     * We do this first because a bad artifact_id drops the whole
     * entry — checking profile leverage on a row we're about to
     * drop is wasted work.
     *
     * The check only runs when the entry actually supplies an
     * artifact_id. The 2026-05-18 prompt revision drives entries
     * off `questionsCovered`, which means transcript-inferred
     * questions arrive with NO artifact_id by design — those are
     * legitimate rows the Analytics tab must render. We only drop
     * when the model produced an artifact_id that doesn't resolve
     * (the historical "hallucinated UUID" case this guardrail was
     * built for).
     */
    if (
      entry.artifact_id !== undefined &&
      !args.validArtifactIds.has(entry.artifact_id)
    ) {
      failures.push({
        event: ANALYTICS_GUARDRAIL_EVENTS.invalidArtifactId,
        reason: `entry references artifact_id '${entry.artifact_id}' which does not belong to this session`,
        originalIndex: i,
        artifactId: entry.artifact_id,
      });
      logGuardrailWarning({
        event: ANALYTICS_GUARDRAIL_EVENTS.invalidArtifactId,
        reason: `artifact_id ${entry.artifact_id} not in session`,
        logTags: args.logTags,
        extra: {
          originalIndex: i,
          artifact_id: entry.artifact_id,
        },
      });
      continue;
    }

    /* ── Guardrails 1 + 2: profile reference validity ─────────── */
    let leverage: ProfileLeverage = entry.profile_leverage;

    if (leverage.referenced_item_id) {
      const validReference =
        (leverage.referenced_item_type === "project" &&
          args.validProjectIds.has(leverage.referenced_item_id)) ||
        (leverage.referenced_item_type === "story" &&
          args.validStoryIds.has(leverage.referenced_item_id)) ||
        // Type missing → check both pools. Defensive: the schema
        // allows the type to be omitted, but we don't trust the
        // model to keep type/id in sync.
        (leverage.referenced_item_type === undefined &&
          (args.validProjectIds.has(leverage.referenced_item_id) ||
            args.validStoryIds.has(leverage.referenced_item_id)));

      if (!validReference) {
        failures.push({
          event: ANALYTICS_GUARDRAIL_EVENTS.hallucinatedReferencedItem,
          reason: `profile_leverage.referenced_item_id '${leverage.referenced_item_id}' (type '${leverage.referenced_item_type ?? "unspecified"}') does not exist in the candidate's projects or stories`,
          originalIndex: i,
          artifactId: entry.artifact_id,
          profileItemId: leverage.referenced_item_id,
        });
        logGuardrailWarning({
          event: ANALYTICS_GUARDRAIL_EVENTS.hallucinatedReferencedItem,
          reason: `referenced_item_id ${leverage.referenced_item_id} not found`,
          logTags: args.logTags,
          extra: {
            originalIndex: i,
            artifact_id: entry.artifact_id,
            referenced_item_id: leverage.referenced_item_id,
            referenced_item_type: leverage.referenced_item_type ?? null,
          },
        });
        leverage = { status: "no_match" };
      }
    }

    if (leverage.suggested_item_id) {
      const validSuggestion =
        args.validProjectIds.has(leverage.suggested_item_id) ||
        args.validStoryIds.has(leverage.suggested_item_id);

      if (!validSuggestion) {
        failures.push({
          event: ANALYTICS_GUARDRAIL_EVENTS.hallucinatedSuggestedItem,
          reason: `profile_leverage.suggested_item_id '${leverage.suggested_item_id}' does not exist in the candidate's projects or stories`,
          originalIndex: i,
          artifactId: entry.artifact_id,
          profileItemId: leverage.suggested_item_id,
        });
        logGuardrailWarning({
          event: ANALYTICS_GUARDRAIL_EVENTS.hallucinatedSuggestedItem,
          reason: `suggested_item_id ${leverage.suggested_item_id} not found`,
          logTags: args.logTags,
          extra: {
            originalIndex: i,
            artifact_id: entry.artifact_id,
            suggested_item_id: leverage.suggested_item_id,
          },
        });
        leverage = { status: "no_match" };
      }
    }

    kept.push({ ...entry, profile_leverage: leverage });
  }

  /* ── Guardrail 4: duration sanity check ──────────────────────
   * Compute over the KEPT entries (post-drop). A guardrail-3 drop
   * shrinks the array AND its duration sum, so this measures the
   * mismatch the user would actually see in the UI. */
  if (kept.length > 0 && args.transcriptDurationSeconds > 0) {
    const totalDuration = kept.reduce((acc, e) => acc + e.duration_seconds, 0);
    const lowerBound = args.transcriptDurationSeconds * DURATION_LOWER_BOUND;
    const upperBound = args.transcriptDurationSeconds * DURATION_UPPER_BOUND;
    if (totalDuration < lowerBound || totalDuration > upperBound) {
      const reason = `sum of duration_seconds (${totalDuration}s) is outside the 80%-120% band of transcript duration (${args.transcriptDurationSeconds}s)`;
      failures.push({
        event: ANALYTICS_GUARDRAIL_EVENTS.durationMismatch,
        reason,
      });
      logGuardrailWarning({
        event: ANALYTICS_GUARDRAIL_EVENTS.durationMismatch,
        reason,
        logTags: args.logTags,
        extra: {
          totalDuration,
          transcriptDuration: args.transcriptDurationSeconds,
          entryCount: kept.length,
        },
      });
    }
  }

  return { entries: kept, failures };
}

function logGuardrailWarning(args: {
  event: AnalyticsGuardrailEvent;
  reason: string;
  logTags?: { sessionId?: string; userId?: string };
  extra?: Record<string, unknown>;
}): void {
  console.warn(`[analytics_guardrail] ${args.event}`, {
    reason: args.reason,
    ...(args.logTags ?? {}),
    ...(args.extra ?? {}),
  });
}
