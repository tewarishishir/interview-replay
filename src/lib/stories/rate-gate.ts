import "server-only";

import type {
  Story,
  StorySuggestedResponseHistoryEntry,
} from "@/lib/db/schema";

/**
 * Per-story daily content gate for the bank-surface suggested
 * response feature.
 *
 * Mirrors `assertSuggestedResponseRateOk` in
 * `src/lib/rebuilds/critique-rate-gate.ts` but reads the
 * `stories.suggested_response_history` column — independent
 * counter from the rebuild-side gate so a user who has burned
 * their rebuild-side budget can still generate from the bank,
 * and vice-versa.
 *
 * Why per-story rather than per-user? Same reason critique +
 * rebuild-suggest are per-rebuild: a content-shaped gate
 * encourages the user to invest their generations in the story
 * they're working on rather than spamming across the bank. The
 * per-user burst limiter (`rebuildCritiqueLimiter`, 12/5min)
 * provides the cross-story DoS guard.
 */

export const STORY_SUGGEST_DAILY_CAP = 10 as const;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class StorySuggestRateLimitError extends Error {
  readonly code = "story_suggest_rate_limited";
  readonly limit: number;
  readonly retryAfterSeconds: number;
  constructor(limit: number, retryAfterSeconds: number) {
    super(
      `Story suggested-response rate limit exceeded: ${limit} suggestions in 24 hours. Try again in ${retryAfterSeconds}s.`,
    );
    this.name = "StorySuggestRateLimitError";
    this.limit = limit;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Count the suggestion runs against this story in the trailing
 * 24 hours.
 */
export function countStorySuggestionsInLast24h(
  story: Story,
  now: Date = new Date(),
): number {
  const cutoff = now.getTime() - ONE_DAY_MS;
  let count = 0;

  const history: ReadonlyArray<StorySuggestedResponseHistoryEntry> =
    Array.isArray(story.suggestedResponseHistory)
      ? story.suggestedResponseHistory
      : [];

  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    const at = (entry as { at?: unknown }).at;
    if (typeof at !== "string") continue;
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= cutoff) count++;
  }

  if (
    story.aiSuggestedResponseJson != null &&
    story.aiSuggestedResponseGeneratedAt != null &&
    story.aiSuggestedResponseGeneratedAt.getTime() >= cutoff
  ) {
    count++;
  }

  return count;
}

function earliestStorySuggestionInWindow(
  story: Story,
  now: Date,
): number | null {
  const cutoff = now.getTime() - ONE_DAY_MS;
  let earliest: number | null = null;

  const history: ReadonlyArray<StorySuggestedResponseHistoryEntry> =
    Array.isArray(story.suggestedResponseHistory)
      ? story.suggestedResponseHistory
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
    story.aiSuggestedResponseJson != null &&
    story.aiSuggestedResponseGeneratedAt != null
  ) {
    const t = story.aiSuggestedResponseGeneratedAt.getTime();
    if (t >= cutoff && (earliest === null || t < earliest)) earliest = t;
  }

  return earliest;
}

/**
 * Throws `StorySuggestRateLimitError` when the story is at or
 * above the 10-per-24h cap. Returns silently otherwise. The
 * route handler maps the throw to 429 with `Retry-After`.
 */
export function assertStorySuggestRateOk(
  story: Story,
  now: Date = new Date(),
): void {
  const count = countStorySuggestionsInLast24h(story, now);
  if (count < STORY_SUGGEST_DAILY_CAP) return;

  const earliest = earliestStorySuggestionInWindow(story, now);
  const retryAtMs =
    earliest !== null ? earliest + ONE_DAY_MS : now.getTime() + 60 * 60 * 1000;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((retryAtMs - now.getTime()) / 1000),
  );
  throw new StorySuggestRateLimitError(
    STORY_SUGGEST_DAILY_CAP,
    retryAfterSeconds,
  );
}
