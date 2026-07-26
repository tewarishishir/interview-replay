import "server-only";

import type {
  RebuildCritiqueHistoryEntry,
  RebuildSuggestedResponseHistoryEntry,
  StoryRebuild,
} from "@/lib/db/schema";

/**
 * Per-rebuild daily content gates.
 *
 * The spec says: "max 10 critiques per rebuild per day per user
 * (prevents accidental cost spirals)". The same gate shape is
 * applied independently to "AI suggested response" generation
 * via `assertSuggestedResponseRateOk` — both are Haiku calls,
 * both can spiral, and they're tracked in separate history
 * arrays so a user who has burned their critique budget can
 * still generate a draft to compare against (and vice-versa).
 *
 * Implementation: count the timestamps in the relevant history
 * column (the append-only log of prior runs) AND the current
 * payload (if present) that fall within the trailing 24-hour
 * window. The current payload is tracked via `updatedAt` for
 * critique (no separate timestamp), and via the explicit
 * `aiSuggestedResponseGeneratedAt` column for suggestions. So
 * the trailing window count is always
 * `history.filter(within 24h).length + (current ? 1 : 0 if
 * current's stamp is within 24h)`.
 *
 * Rate gate runs BEFORE the LLM call. The route handler:
 *   1. Loads the rebuild row.
 *   2. Calls `assertCritiqueRateOk(row)` /
 *      `assertSuggestedResponseRateOk(row)`. If it throws, the
 *      handler returns 429.
 *   3. Runs the LLM call.
 *   4. Persists.
 *
 * We deliberately DON'T use a separate rate-limit store for this:
 *   - The data lives in the DB row already (history). Adding a
 *     separate store adds a write that has to stay consistent with
 *     the row, which is a class of bug we don't want.
 *   - 10/24h is a soft per-rebuild gate, not the kind of burst
 *     limit the auth flow needs. We don't need atomicity across
 *     concurrent requests for the same rebuild — a user
 *     hammering the button on the same rebuild 11 times
 *     concurrently is already a bug worth surfacing.
 *   - The other endpoints (PATCH, save-to-bank) ride on
 *     `profileWriteLimiter` for the per-user burst layer; this
 *     gate is a per-rebuild content layer on top of that.
 */

export const CRITIQUE_DAILY_CAP = 10 as const;
export const SUGGEST_DAILY_CAP = 10 as const;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class RebuildCritiqueRateLimitError extends Error {
  readonly code = "rebuild_critique_rate_limited";
  readonly limit: number;
  readonly retryAfterSeconds: number;
  constructor(limit: number, retryAfterSeconds: number) {
    super(
      `Critique rate limit exceeded: ${limit} critiques in 24 hours. Try again in ${retryAfterSeconds}s.`,
    );
    this.name = "RebuildCritiqueRateLimitError";
    this.limit = limit;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class RebuildSuggestRateLimitError extends Error {
  readonly code = "rebuild_suggest_rate_limited";
  readonly limit: number;
  readonly retryAfterSeconds: number;
  constructor(limit: number, retryAfterSeconds: number) {
    super(
      `Suggested-response rate limit exceeded: ${limit} suggestions in 24 hours. Try again in ${retryAfterSeconds}s.`,
    );
    this.name = "RebuildSuggestRateLimitError";
    this.limit = limit;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Count the critique runs against this rebuild in the trailing
 * 24 hours. Exported for the DTO and unit tests so the same
 * counting logic is used everywhere.
 */
export function countCritiquesInLast24h(
  rebuild: StoryRebuild,
  now: Date = new Date(),
): number {
  const cutoff = now.getTime() - ONE_DAY_MS;
  let count = 0;

  const history: ReadonlyArray<RebuildCritiqueHistoryEntry> = Array.isArray(
    rebuild.critiqueHistory,
  )
    ? rebuild.critiqueHistory
    : [];

  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    const at = (entry as { at?: unknown }).at;
    if (typeof at !== "string") continue;
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= cutoff) count++;
  }

  // The CURRENT critique on `aiCritiqueJson` doesn't carry its
  // own timestamp — it's stamped by the row's `updatedAt`. When
  // present and within the window, count it.
  if (rebuild.aiCritiqueJson != null && rebuild.updatedAt.getTime() >= cutoff) {
    count++;
  }

  return count;
}

/**
 * The "earliest timestamp that's still inside the 24h window"
 * for this rebuild's history. Used to compute Retry-After: the
 * user can run another critique once the OLDEST in-window run
 * falls off the back of the window. Returns `null` when there's
 * no in-window run (the gate is trivially satisfied).
 */
function earliestInWindow(
  rebuild: StoryRebuild,
  now: Date,
): number | null {
  const cutoff = now.getTime() - ONE_DAY_MS;
  let earliest: number | null = null;

  const history: ReadonlyArray<RebuildCritiqueHistoryEntry> = Array.isArray(
    rebuild.critiqueHistory,
  )
    ? rebuild.critiqueHistory
    : [];
  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    const at = (entry as { at?: unknown }).at;
    if (typeof at !== "string") continue;
    const t = Date.parse(at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (earliest === null || t < earliest) earliest = t;
  }

  if (rebuild.aiCritiqueJson != null) {
    const t = rebuild.updatedAt.getTime();
    if (t >= cutoff && (earliest === null || t < earliest)) earliest = t;
  }

  return earliest;
}

/**
 * Throws `RebuildCritiqueRateLimitError` when the rebuild is at
 * or above the 10-per-24h cap. Returns silently otherwise.
 *
 * The route handler maps the throw to 429 with `Retry-After:
 * <retryAfterSeconds>` so a polite client can wait and retry.
 */
export function assertCritiqueRateOk(
  rebuild: StoryRebuild,
  now: Date = new Date(),
): void {
  const count = countCritiquesInLast24h(rebuild, now);
  if (count < CRITIQUE_DAILY_CAP) return;

  const earliest = earliestInWindow(rebuild, now);
  // earliest will not be null when count >= cap (count > 0 implies
  // at least one in-window timestamp). Defense-in-depth: if it
  // somehow is null, retry-after of 1 hour is a sane default that
  // keeps the user moving.
  const retryAtMs =
    earliest !== null ? earliest + ONE_DAY_MS : now.getTime() + 60 * 60 * 1000;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((retryAtMs - now.getTime()) / 1000),
  );
  throw new RebuildCritiqueRateLimitError(
    CRITIQUE_DAILY_CAP,
    retryAfterSeconds,
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Suggested-response gate (parallel to critique)                 */
/* ────────────────────────────────────────────────────────────── */

/**
 * Count the suggestion runs against this rebuild in the trailing
 * 24 hours. Mirrors `countCritiquesInLast24h` but reads
 * `suggestedResponseHistory` and the
 * `aiSuggestedResponseGeneratedAt` timestamp (which IS stamped
 * separately on the row, unlike `aiCritiqueJson` whose freshness
 * is read off `updatedAt`).
 */
export function countSuggestionsInLast24h(
  rebuild: StoryRebuild,
  now: Date = new Date(),
): number {
  const cutoff = now.getTime() - ONE_DAY_MS;
  let count = 0;

  const history: ReadonlyArray<RebuildSuggestedResponseHistoryEntry> = Array.isArray(
    rebuild.suggestedResponseHistory,
  )
    ? rebuild.suggestedResponseHistory
    : [];

  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    const at = (entry as { at?: unknown }).at;
    if (typeof at !== "string") continue;
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= cutoff) count++;
  }

  if (
    rebuild.aiSuggestedResponseJson != null &&
    rebuild.aiSuggestedResponseGeneratedAt != null &&
    rebuild.aiSuggestedResponseGeneratedAt.getTime() >= cutoff
  ) {
    count++;
  }

  return count;
}

function earliestSuggestionInWindow(
  rebuild: StoryRebuild,
  now: Date,
): number | null {
  const cutoff = now.getTime() - ONE_DAY_MS;
  let earliest: number | null = null;

  const history: ReadonlyArray<RebuildSuggestedResponseHistoryEntry> = Array.isArray(
    rebuild.suggestedResponseHistory,
  )
    ? rebuild.suggestedResponseHistory
    : [];
  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    const at = (entry as { at?: unknown }).at;
    if (typeof at !== "string") continue;
    const t = Date.parse(at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (earliest === null || t < earliest) earliest = t;
  }

  if (
    rebuild.aiSuggestedResponseJson != null &&
    rebuild.aiSuggestedResponseGeneratedAt != null
  ) {
    const t = rebuild.aiSuggestedResponseGeneratedAt.getTime();
    if (t >= cutoff && (earliest === null || t < earliest)) earliest = t;
  }

  return earliest;
}

/**
 * Throws `RebuildSuggestRateLimitError` when the rebuild is at
 * or above the 10-per-24h cap for suggested-response generation.
 * Returns silently otherwise.
 */
export function assertSuggestedResponseRateOk(
  rebuild: StoryRebuild,
  now: Date = new Date(),
): void {
  const count = countSuggestionsInLast24h(rebuild, now);
  if (count < SUGGEST_DAILY_CAP) return;

  const earliest = earliestSuggestionInWindow(rebuild, now);
  const retryAtMs =
    earliest !== null ? earliest + ONE_DAY_MS : now.getTime() + 60 * 60 * 1000;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((retryAtMs - now.getTime()) / 1000),
  );
  throw new RebuildSuggestRateLimitError(
    SUGGEST_DAILY_CAP,
    retryAfterSeconds,
  );
}
