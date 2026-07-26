"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { postRebuild, RebuildApiError } from "@/lib/rebuilds/api-client";
import type { PerQuestionAnalytics, QuestionCovered } from "@/lib/llm";

import { MergedQuestionRow } from "./MergedQuestionRow";
import {
  buildAnalyticsLookup,
  findAnalyticsMatch,
  questionKey,
} from "./analytics-utils";

export interface MergedQuestionsListProps {
  /**
   * `per_question_analytics` rows from the report — drives STAR
   * badges, metrics, and the Rebuild button on each row. Optional
   * because the merged tab still renders the coverage-only side
   * of the list on legacy reports / post-launch reports where the
   * LLM dropped the section.
   */
  items?: ReadonlyArray<PerQuestionAnalytics>;
  /**
   * `questionsCovered` from the same report — drives the
   * confidence pill, source pill, and evidence quote on each row.
   * Optional because older reports (pre-`questionsCovered`) still
   * have to render the analytics-only side of the list.
   */
  questionsCovered?: ReadonlyArray<QuestionCovered>;
  /**
   * Owning session id. Required for the rebuild POST and for the
   * `session_analytics_question_clicked` /
   * `session_analytics_rebuild_clicked` payloads — when `null`
   * (Storybook / unit harness / historical viewer) the rebuild
   * affordances are hidden and clicks still fire the scroll
   * callback the parent owns.
   */
  sessionId: string | null;
  /**
   * Per-row click. Forwarded to the orchestrator (which owns the
   * scroll-to-transcript decision and the analytics event). The
   * analytics arg is `null` for coverage-only rows.
   */
  onCardClick: (
    item: PerQuestionAnalytics | null,
    index: number,
  ) => void;
  /**
   * Per-row rebuild click. Fires BEFORE the POST so the analytics
   * funnel still credits the click on a 5xx outcome.
   */
  onRebuildClick: (
    item: PerQuestionAnalytics,
    index: number,
    source: "card_button" | "profile_indicator",
  ) => void;
}

/**
 * Merged "Questions covered & Analytics" list.
 *
 * Walks `questionsCovered` as the primary order (chronological,
 * candidate-confirmed-friendly) and pairs each row with its
 * matching analytics entry via `findAnalyticsMatch`. Any analytics
 * rows that didn't pair (string drift, post-launch "LLM emitted an
 * analytics row whose text doesn't appear in `questionsCovered`",
 * etc.) are appended at the end with `coverage = null` — better to
 * surface the analytics than silently drop it.
 *
 * Owns the rebuild POST. The orchestrator does NOT — keeping the
 * network call here keeps the data flow unidirectional (parent
 * passes the click hooks down; the row stays presentational).
 * `session_analytics_rebuild_clicked` fires from the
 * orchestrator's `onRebuildClick` BEFORE the POST so the funnel
 * captures clicks even when the create call later fails.
 */
export function MergedQuestionsList({
  items,
  questionsCovered,
  sessionId,
  onCardClick,
  onRebuildClick,
}: MergedQuestionsListProps): React.ReactElement | null {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // `null` = no override; everything else means the "Expand all"
  // toggle was last touched and is overriding the per-row local
  // state. The first time a user clicks an individual row, the
  // override is dropped so subsequent clicks behave normally.
  const [allExpandedOverride, setAllExpandedOverride] = useState<
    boolean | null
  >(null);

  // Build the union list once per render. Cheap on the 30-question
  // ceiling (two passes + a Map lookup per coverage row).
  const rows = useMemo(() => {
    return buildMergedRows(items, questionsCovered);
  }, [items, questionsCovered]);

  const handleExpandedChange = useCallback(
    (expanded: boolean, index: number) => {
      // A per-row click means the user's interaction overrides
      // the "Expand all / Collapse all" toggle — drop the
      // override so subsequent toggles work as expected.
      setAllExpandedOverride(null);
      if (
        typeof window === "undefined" ||
        sessionId === null
      ) {
        return;
      }
      // Analytics event placeholder (external tracking removed).
    },
    [rows, sessionId],
  );

  const handleRebuild = useCallback(
    async (
      item: PerQuestionAnalytics,
      index: number,
      source: "card_button" | "profile_indicator",
    ) => {
      onRebuildClick(item, index, source);

      if (sessionId === null) return;
      setError(null);
      const preselected =
        item.profile_leverage.status === "available_unused"
          ? item.profile_leverage.suggested_item_id
          : undefined;

      try {
        // `source_artifact_id` is omitted for transcript-inferred
        // questions (no backing artifact row). The rebuild API
        // already treats the field as optional and falls back to
        // `source_session_id` for ownership, so the rebuild flow
        // works end-to-end either way.
        const { rebuild } = await postRebuild({
          source_session_id: sessionId,
          ...(item.artifact_id
            ? { source_artifact_id: item.artifact_id }
            : {}),
          pre_selected_profile_item_id: preselected,
          question_text:
            item.question_text.length > 1000
              ? item.question_text.slice(0, 1000)
              : item.question_text,
        });
        router.push(`/rebuilds/${rebuild.id}`);
      } catch (err) {
        setError(
          err instanceof RebuildApiError
            ? err.message
            : "We couldn't start your rebuild. Try again.",
        );
      }
    },
    [onRebuildClick, sessionId, router],
  );

  if (rows.length === 0) return null;

  const expandAllVisible = rows.length > 1;

  return (
    <section aria-labelledby="merged-questions-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3
            id="merged-questions-heading"
            className="text-base font-medium text-foreground"
            style={{ fontSize: "16px" }}
          >
            Per-question breakdown
          </h3>
          <p
            className="mt-1 text-muted-foreground"
            style={{ fontSize: "13px" }}
          >
            Tap a question to see metrics and rebuild options.
          </p>
        </div>
        {expandAllVisible && (
          <button
            type="button"
            data-testid="expand-all-toggle"
            onClick={() =>
              setAllExpandedOverride((prev) => (prev === true ? false : true))
            }
            style={{
              fontSize: "12px",
              color: "var(--color-text-secondary)",
              background: "transparent",
              border: "none",
              padding: "4px 0",
              cursor: "pointer",
              textDecoration: "underline",
              textUnderlineOffset: "2px",
            }}
          >
            {allExpandedOverride === true ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>

      <div
        className="mt-4 flex flex-col"
        style={{ gap: "8px" }}
        role="list"
      >
        {rows.map((row, i) => (
          <div
            key={
              row.analytics?.artifact_id ??
              `row-${i}-${
                row.coverage?.question ??
                row.analytics?.question_text ??
                ""
              }`
            }
            role="listitem"
          >
            <MergedQuestionRow
              index={i}
              coverage={row.coverage}
              analytics={row.analytics}
              onCardClick={onCardClick}
              onRebuildClick={handleRebuild}
              rebuildEnabled={sessionId !== null}
              onExpandedChange={handleExpandedChange}
              expanded={allExpandedOverride ?? undefined}
            />
          </div>
        ))}
      </div>

      {error !== null && (
        <p
          role="alert"
          className="mt-3"
          style={{ fontSize: "12px", color: "var(--color-danger)" }}
        >
          {error}
        </p>
      )}
    </section>
  );
}

interface MergedRow {
  coverage: QuestionCovered | null;
  analytics: PerQuestionAnalytics | null;
}

/**
 * Pure pairing helper — exported indirectly via the component so
 * the merge logic stays unit-testable without a DOM if we ever
 * add coverage for it.
 *
 * Walks `questionsCovered` first (preserves the chronological
 * order the candidate sees), pulling the paired analytics row in
 * via the normalised-key lookup. Then sweeps the analytics list
 * for any unconsumed entries and appends them with
 * `coverage = null` so the row still surfaces its STAR / metrics.
 */
function buildMergedRows(
  items: ReadonlyArray<PerQuestionAnalytics> | undefined,
  questionsCovered: ReadonlyArray<QuestionCovered> | undefined,
): ReadonlyArray<MergedRow> {
  const analyticsLookup = buildAnalyticsLookup(items);
  const consumedAnalyticsKeys = new Set<string>();
  const out: MergedRow[] = [];

  for (const cov of questionsCovered ?? []) {
    const analytics = findAnalyticsMatch(cov, analyticsLookup);
    if (analytics !== null) {
      consumedAnalyticsKeys.add(questionKey(analytics.question_text));
    }
    out.push({ coverage: cov, analytics });
  }

  for (const item of items ?? []) {
    const key = questionKey(item.question_text);
    if (consumedAnalyticsKeys.has(key)) continue;
    consumedAnalyticsKeys.add(key);
    out.push({ coverage: null, analytics: item });
  }

  return out;
}
