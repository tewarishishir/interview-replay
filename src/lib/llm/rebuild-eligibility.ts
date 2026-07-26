import type { Improvement } from "./schema";

/**
 * Read-only helpers for the report view's "should we render the
 * inline Rebuild button under THIS improvement?" decision.
 *
 * Single source of truth so the view, the orientation-note count,
 * and the unit tests all agree on what "rebuild-eligible" means.
 *
 * The decision itself is the model's (`improvement.rebuildEligible`)
 * — these helpers just read the flag with the legacy-report fallback
 * baked in (Option A in the rebuild-refactor spec: any improvement
 * persisted before the field was introduced parses through the Zod
 * schema with `rebuildEligible` defaulted to `false`, which means
 * older reports surface no inline button at all rather than a wrong
 * one).
 */

/**
 * True when the model marked this improvement eligible for the
 * structured rebuild flow. The strict equality on `true` is
 * deliberate: a future schema relaxation that lets the field be
 * `null` or `undefined` must NOT silently flip to "show the
 * button" — Option A's fallback is "no button".
 */
export function isRebuildEligible(improvement: Improvement): boolean {
  return improvement.rebuildEligible === true;
}

/**
 * Count of rebuild-eligible improvements in a report. The
 * orientation note at the top of the Improvements section uses
 * this to render "{n} of {total} improvements below can be turned
 * into structured rebuilds — look for the rebuild button."
 *
 * Returns the raw `total` alongside `eligible` so the caller can
 * compose the copy in one place; computing both here keeps the
 * iteration to a single pass.
 */
export function countRebuildEligible(
  improvements: ReadonlyArray<Improvement>,
): { eligible: number; total: number } {
  let eligible = 0;
  for (const m of improvements) {
    if (isRebuildEligible(m)) eligible++;
  }
  return { eligible, total: improvements.length };
}

/**
 * Copy for the orientation note above the Improvements list.
 *
 * Branches on count to avoid grammar misses the simpler
 * "{n} of {total} improvements …" template would produce:
 *
 *   - total === 1            → "The improvement below can be …"
 *   - eligible === total > 1 → "All {n} improvements below can be …"
 *   - otherwise              → "{n} of {total} improvements …"
 *
 * The view already gates on `eligible > 0` before rendering, so
 * we don't have a zero-eligible branch — this helper only ever
 * runs when the note is actually about to display. (We still
 * defend against the impossible-but-cheap case at the bottom by
 * falling through to the "X of Y" wording, which reads sanely
 * for any positive `eligible`.)
 *
 * Lives in this module rather than inside `report-view.tsx` so
 * the grammar contract has a unit test that catches a future
 * "1 improvements" regression without spinning up a React
 * renderer.
 */
export function orientationNoteCopy(counts: {
  eligible: number;
  total: number;
}): string {
  const { eligible, total } = counts;
  if (total === 1) {
    return "The improvement below can be turned into a structured rebuild — look for the rebuild button.";
  }
  if (eligible === total) {
    return `All ${total} improvements below can be turned into structured rebuilds — look for the rebuild button.`;
  }
  return `${eligible} of ${total} improvements below can be turned into structured rebuilds — look for the rebuild button.`;
}
