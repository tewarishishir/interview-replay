/**
 * Narrative-line generators for the Analytics tab. Each function
 * takes the output of one of `per-session.ts`'s aggregators and
 * returns either a single italic sentence the tab renders below
 * the chart, or `null` when no narrative is warranted (the chart
 * alone is sufficient).
 *
 * Pure functions, no side effects, no I/O. Safe to import in both
 * server-rendered and client-rendered contexts.
 *
 * CRITICAL LANGUAGE RULE — pace narratives MUST NEVER contain the
 * judgmental words "slow" or "fast". The Analytics tab is a
 * coaching surface, not a graded report; descriptive terms
 * ("measured", "brisk", "high-tempo", "ease the tempo") communicate
 * the same information without judgment. The pace-narrative tests
 * pin this contract.
 */

import type {
  AnswerLengthClassification,
  StarCompleteness,
  TimeDistributionEntry,
} from "./per-session";

/* ────────────────────────────────────────────────────────────── */
/* STAR completeness narrative                                    */
/* ────────────────────────────────────────────────────────────── */

/**
 * Per-dimension nouns that read naturally inside the missing-pct
 * sentence. Pinned by tests so a future copy edit on the chart
 * labels (e.g. renaming "Task" to "Goal") can't drift this string
 * silently.
 */
const STAR_DIMENSION_NOUNS = {
  situation: "situation",
  task: "clear task",
  action: "concrete action",
  result: "quantified outcome",
} as const;

const STAR_DIMENSION_LABELS = {
  situation: "Situation",
  task: "Task",
  action: "Action",
  result: "Result",
} as const;

/**
 * Generate the italic line under the STAR-completeness chart, or
 * `null` when none of the dimensions are weak enough to call out.
 *
 * Selection logic:
 *   1. Pick the dimension with the lowest `present` count (ties
 *      broken by the canonical order S → T → A → R so the same
 *      data always produces the same narrative).
 *   2. If that dimension's `missing %` is ≥ 30, surface a "X is
 *      your weakest — N% of answers ended without …" line.
 *   3. Else, if its `weak %` is ≥ 40, surface a softer "X was
 *      present but underdeveloped" line.
 *   4. Else return `null` — the chart speaks for itself.
 *
 * All percentages are computed off the per-dimension `total`
 * (i.e. the number of scoreable entries that contributed to THAT
 * bar), not `totalScoreable`. That avoids the "no-data dim" edge
 * case where a dimension has zero contributors but the chart
 * still has rows.
 */
export function generateStarNarrative(
  starData: StarCompleteness,
): string | null {
  const dimensions = ["situation", "task", "action", "result"] as const;

  // Pick the lowest-present dimension. Ties resolved by the fixed
  // S → T → A → R order: we initialise from `situation` and only
  // overwrite on a strictly-lower present count.
  let weakest: (typeof dimensions)[number] = "situation";
  let weakestPresent = starData.situation.present;
  for (const dim of dimensions) {
    if (starData[dim].present < weakestPresent) {
      weakest = dim;
      weakestPresent = starData[dim].present;
    }
  }

  const totals = starData[weakest];
  if (totals.total === 0) return null;

  const missingPct = (totals.missing / totals.total) * 100;
  const weakPct = (totals.weak / totals.total) * 100;

  if (missingPct >= 30) {
    return `${STAR_DIMENSION_LABELS[weakest]} is your weakest — ${Math.round(missingPct)}% of your answers ended without a ${STAR_DIMENSION_NOUNS[weakest]}.`;
  }
  if (weakPct >= 40) {
    return `${STAR_DIMENSION_LABELS[weakest]} was present but underdeveloped in many answers.`;
  }
  return null;
}

/* ────────────────────────────────────────────────────────────── */
/* Length-discipline narrative                                    */
/* ────────────────────────────────────────────────────────────── */

/**
 * Format `seconds` as a M:SS string. Used in the length-discipline
 * single-outlier narrative ("Q3 stands out at 4:20 …"). Floors the
 * seconds and pads with a leading zero so 65s reads as "1:05".
 *
 * Exported so the per-session tests can assert the format without
 * re-implementing it.
 */
export function formatMmSs(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Round a seconds value to the nearest half-minute. Used in the
 * outlier narrative ("ran longer than 4 minutes" / "longer than
 * 4.5 minutes"). 145s → 2.5 minutes (rounded from 2.417).
 */
function toNearestHalfMinute(seconds: number): number {
  return Math.round(seconds / 30) / 2;
}

/**
 * Render a half-minute value as a friendly string. Drops the
 * trailing ".0" so a 4.0-minute value reads as "4", not "4.0".
 */
function formatHalfMinutes(halfMinutes: number): string {
  return Number.isInteger(halfMinutes)
    ? String(halfMinutes)
    : halfMinutes.toFixed(1);
}

/**
 * Narrative for the length-discipline chart. Three branches in
 * priority order:
 *
 *   1. Outliers on both sides (≥2 long OR ≥2 short): nudge toward
 *      consistency. Quotes the maximum duration so the user has
 *      a concrete number to anchor their next-rehearsal target.
 *   2. Single long-only outlier with the rest in target: single
 *      it out specifically ("Q3 stands out at 4:20 …"). Index is
 *      1-based against the input order (which matches how the
 *      UI labels the bars).
 *   3. Every answer in target: positive feedback.
 *
 * Returns `null` when the distribution is plausible-but-mixed and
 * none of the branches fit — the chart alone is fine in that case.
 *
 * @param lengthData The classification rows from
 *   `classifyAnswerLengths`. Index in this array is the source of
 *   the "Q{N}" label in branch 2 (1-based).
 */
export function generateLengthNarrative(
  lengthData: ReadonlyArray<AnswerLengthClassification>,
): string | null {
  if (lengthData.length === 0) return null;

  // The narrative only speaks to the candidate's GRADABLE answers
  // (closing / clarification questions aren't scored against the
  // 90–180s target). Counting them would falsely inflate the
  // "short" count and break the "all in range" praise branch.
  const gradable = lengthData.filter((d) => d.band !== "meta");
  if (gradable.length === 0) return null;

  const countLong = gradable.filter((d) => d.band === "long").length;
  const countShort = gradable.filter((d) => d.band === "short").length;
  const countInRange = gradable.filter((d) => d.band === "in_range").length;

  if (countLong >= 2 || countShort >= 2) {
    const maxDurationSeconds = gradable.reduce(
      (acc, d) => Math.max(acc, d.duration_seconds),
      0,
    );
    const maxDurationMin = toNearestHalfMinute(maxDurationSeconds);
    return `${countLong} answer(s) ran longer than ${formatHalfMinutes(maxDurationMin)} minutes; ${countShort} ran under a minute. Aim for consistency around 2–3 minutes per answer.`;
  }

  if (countLong === 1 && countInRange >= countLong * 2) {
    // Use the ORIGINAL `lengthData` index so the Q-N label matches
    // the chart's bar order (meta bars are visible on the chart and
    // count toward the position numbering).
    const idx = lengthData.findIndex((d) => d.band === "long");
    if (idx >= 0) {
      const longItem = lengthData[idx]!;
      return `Q${idx + 1} stands out at ${formatMmSs(longItem.duration_seconds)} — most other answers were in the target range.`;
    }
  }

  if (countInRange === gradable.length) {
    return "All answers landed in the target range — strong length discipline.";
  }

  return null;
}

/* ────────────────────────────────────────────────────────────── */
/* Time-distribution narrative                                    */
/* ────────────────────────────────────────────────────────────── */

/**
 * Always returns a non-null narrative (the chart always benefits
 * from a one-sentence read of the shape). Three branches:
 *
 *   1. Top-2-dominate: the top two questions combined ate > 40%
 *      of the round AND each ran > 25%. Call out both with a
 *      threshold the user can rehearse against.
 *   2. Top-1-dominates: top question ran > 25% by itself.
 *   3. Even distribution.
 *
 * The threshold in branch 1 is the minimum of the two durations
 * rounded down to the nearest half-minute — that's the number
 * BOTH answers exceeded, so the sentence stays accurate.
 *
 * "Q{N}" indices are 1-based against the ORIGINAL input order, so
 * they line up with the chart bars (the renderer also iterates
 * `distData` left-to-right). We re-derive the index after sorting
 * via an artifact-id lookup.
 */
export function generateTimeDistributionNarrative(
  distData: ReadonlyArray<TimeDistributionEntry>,
): string {
  if (distData.length === 0) {
    return "Time was distributed relatively evenly across questions.";
  }

  // 1-based labels match the chart's "Q1, Q2, …" axis.
  const labelByArtifact = new Map<string, number>();
  distData.forEach((d, i) => labelByArtifact.set(d.artifact_id, i + 1));

  // Sort a copy by percent desc so the original order (for labels)
  // stays intact. Tie-break on the original index so the result is
  // deterministic when two questions ran exactly the same length.
  const sorted = distData
    .map((d, i) => ({ ...d, originalIndex: i }))
    .sort(
      (a, b) =>
        b.percent - a.percent || a.originalIndex - b.originalIndex,
    );

  const top = sorted[0]!;
  const second = sorted[1];
  const topLabel = labelByArtifact.get(top.artifact_id) ?? 1;

  if (second && top.percent + second.percent > 40 && top.percent > 25 && second.percent > 25) {
    const secondLabel = labelByArtifact.get(second.artifact_id) ?? 2;
    const combined = Math.round(top.percent + second.percent);
    // Threshold the user rehearses against: the SHORTER of the
    // two durations, rounded DOWN to the nearest half-minute so
    // "longer than X" is technically true for both.
    const minDuration = Math.min(top.duration_seconds, second.duration_seconds);
    const thresholdMin = Math.floor(minDuration / 30) / 2;
    return `Q${topLabel} and Q${secondLabel} took ${combined}% of the interview — both ran longer than ${formatHalfMinutes(thresholdMin)} minutes.`;
  }

  if (top.percent > 25) {
    return `Q${topLabel} took ${Math.round(top.percent)}% of the interview — significantly more than the others.`;
  }

  return "Time was distributed relatively evenly across questions.";
}

/* ────────────────────────────────────────────────────────────── */
/* Pace narrative                                                 */
/* ────────────────────────────────────────────────────────────── */

/**
 * Render the italic line under the pace gauge. Five WPM bands:
 *
 *   < 100   — measured (low energy risk)
 *   100..119 — slightly measured
 *   120..170 — conversational (target)
 *   171..200 — brisk
 *   > 200   — very brisk (processing-load risk)
 *
 * Boundary semantics: 100, 120, 171, 201 all snap to the band
 * STARTING at that value. Tests pin every boundary.
 *
 * The strings DELIBERATELY avoid the judgmental words "slow" and
 * "fast". The pace gauge is a coaching surface — a candidate who
 * sees "you talk fast" reads it as a verdict, but "brisk pace"
 * reads as a description they can act on. Tests assert the
 * absence of both forbidden words.
 */
export function generatePaceNarrative(wpm: number): string {
  if (wpm < 100) {
    return "Measured pace — consider whether to add energy at key moments.";
  }
  if (wpm < 120) {
    return "Slightly measured — comfortable for the listener but may read as low-energy in high-tempo rounds.";
  }
  if (wpm <= 170) {
    return "Conversational pace — interviewers can follow comfortably.";
  }
  if (wpm <= 200) {
    return "Brisk pace — make sure key points are landing, not getting rushed past.";
  }
  return "Very brisk — likely creating processing load on the interviewer. Ease the tempo at moments of impact.";
}
