/**
 * Pure aggregation functions over `report_json.per_question_analytics`.
 *
 * The Analytics tab UI (Prompt 3) renders the chart data these
 * functions produce. They live here, in their own module, because:
 *
 *   1. They are pure — no I/O, no DB, no env access — so they
 *      unit-test cleanly and run in any environment (server,
 *      browser, or Vitest).
 *   2. They are deterministic. The same input always produces the
 *      same output, which means the UI can server-render the
 *      analytics tab on `/sessions/:id/report` without a follow-
 *      up client request.
 *   3. They are independent of the LLM. A future swap of the
 *      analyze model only needs to keep its output schema-valid;
 *      the UI's bar widths still come from these helpers.
 *
 * No `"server-only"` directive: the module is deliberately
 * import-safe on the client (the analytics tab renders on the
 * server but the same charts may be re-renderable on the client
 * after a status update).
 */

import type { PerQuestionAnalytics } from "@/lib/llm";

/* ────────────────────────────────────────────────────────────── */
/* STAR completeness                                              */
/* ────────────────────────────────────────────────────────────── */

/**
 * One STAR dimension's rollup — counts of 'present' / 'weak' /
 * 'missing' answers for that dimension, plus the total denominator
 * (the number of entries that had a real STAR assessment, i.e.
 * weren't all-'na').
 */
export interface StarDimensionTotals {
  present: number;
  weak: number;
  missing: number;
  /**
   * Number of scoreable entries contributing to this dimension's
   * counts. Equals `present + weak + missing`. Carried explicitly
   * so the renderer doesn't have to re-sum the bars to compute
   * percentages.
   */
  total: number;
}

export interface StarCompleteness {
  situation: StarDimensionTotals;
  task: StarDimensionTotals;
  action: StarDimensionTotals;
  result: StarDimensionTotals;
  /**
   * Number of entries that contributed to ANY dimension count —
   * i.e. entries whose `star_signals` weren't all-'na'. Used by
   * the chart title ("STAR completeness across N answers").
   */
  totalScoreable: number;
}

/**
 * Build the STAR completeness rollup. Filters out entries whose
 * `star_signals` are all 'na' (closing / clarification questions
 * have no STAR shape to grade) so the chart denominator reflects
 * only the answers that COULD have STAR scaffolding.
 *
 * Order of dimensions in the returned object is fixed
 * (situation → task → action → result) so the renderer can iterate
 * `Object.entries` without sorting.
 */
export function aggregateStarCompleteness(
  items: ReadonlyArray<PerQuestionAnalytics>,
): StarCompleteness {
  const init = (): StarDimensionTotals => ({
    present: 0,
    weak: 0,
    missing: 0,
    total: 0,
  });

  const result: StarCompleteness = {
    situation: init(),
    task: init(),
    action: init(),
    result: init(),
    totalScoreable: 0,
  };

  for (const item of items) {
    const s = item.star_signals;
    // All-'na' rows don't contribute to ANY bar — closing /
    // clarification questions have no STAR shape to assess and
    // would dilute the chart's signal.
    if (
      s.situation === "na" &&
      s.task === "na" &&
      s.action === "na" &&
      s.result === "na"
    ) {
      continue;
    }
    result.totalScoreable++;

    for (const dim of ["situation", "task", "action", "result"] as const) {
      const value = s[dim];
      if (value === "na") continue; // partial-na: row counted, dim skipped.
      result[dim][value]++;
      result[dim].total++;
    }
  }

  return result;
}

/* ────────────────────────────────────────────────────────────── */
/* Answer length bands                                            */
/* ────────────────────────────────────────────────────────────── */

/**
 * A length-discipline classification.
 *
 *   - `short` / `in_range` / `long`: gradable answer relative to the
 *     90–180s target window.
 *   - `meta`: closing or clarification question — these still appear
 *     on the chart (so the candidate sees every question they
 *     answered), but they aren't graded against the target window.
 *     The renderer uses a neutral color for `meta` bars and the
 *     narrative generator excludes them from short/long counts.
 */
export type LengthBand = "short" | "in_range" | "long" | "meta";

export interface AnswerLengthClassification {
  /**
   * Stable client-side key for this classification row. Equal to
   * the source `PerQuestionAnalytics.artifact_id` when the LLM
   * supplied one (artifact-backed question); otherwise a synthetic
   * `q-${arrayIndex}` so the React renderer still has a unique
   * `key` prop AND so dedupe-style downstream consumers (e.g.
   * narrative-line generators) can keep distinct transcript-
   * inferred questions distinct.
   *
   * The 2026-05-18 prompt revision lets transcript-inferred
   * questions ship without an `artifact_id` (they have no backing
   * artifact row to reference) — the synthetic key makes the
   * client-side data flow agnostic to whether the LLM had a UUID
   * to copy in.
   */
  artifact_id: string;
  duration_seconds: number;
  band: LengthBand;
}

/**
 * Boundaries (in seconds) for the length-discipline bands.
 *
 *   < 90s          → 'short'    (answer was rushed / too thin)
 *   90s..180s      → 'in_range' (target sweet spot)
 *   > 180s         → 'long'     (answer ran long / lost the thread)
 *
 * Boundary semantics: 90 is inclusive of `in_range`; 180 is
 * inclusive of `in_range`. So 90s and 180s both classify as
 * `in_range`; 89s is `short`, 181s is `long`. The narrative
 * generators rely on this exact mapping.
 */
export const ANSWER_LENGTH_SHORT_THRESHOLD_S = 90;
export const ANSWER_LENGTH_LONG_THRESHOLD_S = 180;

/**
 * Classify each question into a length band.
 *
 * Includes ALL question types so the chart shows every question the
 * candidate answered (the previous behavior dropped closing /
 * clarification rows entirely, which made the chart appear to have
 * fewer questions than the rest of the report listed).
 *
 * Closing and clarification questions are flagged with the `meta`
 * band rather than scored against the 90/180s target — the target
 * was calibrated for substantive answers, so labelling a 20-second
 * "Any questions for me?" as `short` would be misleading. The
 * renderer paints `meta` bars in a neutral color and the narrative
 * generator excludes them from short/long counts.
 */
export function classifyAnswerLengths(
  items: ReadonlyArray<PerQuestionAnalytics>,
): AnswerLengthClassification[] {
  return items.map((item, index) => {
    const isMeta =
      item.question_type === "closing" ||
      item.question_type === "clarification";
    const band: LengthBand = isMeta
      ? "meta"
      : item.duration_seconds < ANSWER_LENGTH_SHORT_THRESHOLD_S
        ? "short"
        : item.duration_seconds > ANSWER_LENGTH_LONG_THRESHOLD_S
          ? "long"
          : "in_range";
    return {
      artifact_id: item.artifact_id ?? `q-${index}`,
      duration_seconds: item.duration_seconds,
      band,
    };
  });
}

/* ────────────────────────────────────────────────────────────── */
/* Time distribution                                              */
/* ────────────────────────────────────────────────────────────── */

export interface TimeDistributionEntry {
  /**
   * Stable client-side key. Equal to the source
   * `PerQuestionAnalytics.artifact_id` when one exists, otherwise
   * a synthetic `q-${arrayIndex}` — see the same comment on
   * `AnswerLengthClassification.artifact_id` for the rationale.
   */
  artifact_id: string;
  duration_seconds: number;
  /** Share of the round's total time spent on this question (0-100). */
  percent: number;
}

/**
 * For each question, compute the share of the round's total time
 * spent on it (as a percentage). Includes ALL question types — a
 * closing question still consumed time and belongs on the chart.
 *
 * Edge case: a session whose total duration sum is zero (all
 * `duration_seconds: 0`) returns every percent as 0. The renderer
 * surfaces this as a "no timing data" empty state instead of a
 * division-by-zero.
 *
 * Order is preserved from the input array so the renderer's Q-N
 * labels line up with the report's question order.
 */
export function computeTimeDistribution(
  items: ReadonlyArray<PerQuestionAnalytics>,
): TimeDistributionEntry[] {
  const total = items.reduce((acc, i) => acc + i.duration_seconds, 0);
  if (total === 0) {
    return items.map((i, index) => ({
      artifact_id: i.artifact_id ?? `q-${index}`,
      duration_seconds: i.duration_seconds,
      percent: 0,
    }));
  }
  return items.map((i, index) => ({
    artifact_id: i.artifact_id ?? `q-${index}`,
    duration_seconds: i.duration_seconds,
    percent: (i.duration_seconds / total) * 100,
  }));
}

/* ────────────────────────────────────────────────────────────── */
/* Speech pace                                                    */
/* ────────────────────────────────────────────────────────────── */

export type SpeechPace = "measured" | "conversational" | "brisk";

/**
 * Classify a words-per-minute value into a coarse pace band. The
 * Analytics tab's pace gauge uses this label as the headline.
 *
 *   < 120 wpm  → 'measured'        (calm, possibly low-energy)
 *   120..170   → 'conversational'  (target band)
 *   > 170      → 'brisk'           (high-energy, watch for rushing)
 *
 * NOTE the boundaries: 120 wpm is conversational, not measured;
 * 170 wpm is conversational, not brisk. Tests pin these.
 *
 * The labels are deliberately descriptive — never "slow" or
 * "fast" — so the narrative generators in `narratives.ts` (and
 * the gauge component in Prompt 4) can avoid judgmental language.
 */
export function classifySpeechPace(wpm: number): SpeechPace {
  if (wpm < 120) return "measured";
  if (wpm > 170) return "brisk";
  return "conversational";
}
