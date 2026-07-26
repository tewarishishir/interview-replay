import "server-only";

import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * Per-user 10/24h daily content gate for the story-bank AI
 * surfaces: `POST /api/stories/critique` and
 * `POST /api/stories/enhance`.
 *
 * Critique and enhance share a single per-user budget so a user
 * can run up to 10 story AI operations (any mix of critiques and
 * applies) per day — identical to how the rebuild surface shares
 * the per-rebuild critique+enhance budget from `critiqueHistory`.
 *
 * ## Why per-user, not per-story?
 *
 * The story-bank critique/enhance are stateless — no story row is
 * created during the call (the user may be critiquing a draft
 * before saving it). There is no entity whose `critique_history`
 * array we could append to, so we use the `audit_log` count
 * approach instead.
 *
 * ## Implementation: audit_log count
 *
 * Every successful critique writes a `story_critique.unit_charged`
 * row and every successful enhance writes a
 * `story_enhance.unit_charged` row to `audit_log` (via
 * `chargeRebuildCritique`). We count BOTH event types in the
 * trailing 24 hours for the given user.
 *
 * ## Retry-After
 *
 * The rate limit error carries `retryAfterSeconds` so the route
 * can set a `Retry-After` header. We compute it from the OLDEST
 * in-window audit row: once that row is 24 hours old it falls off
 * the window, freeing one slot.
 */

export const STORY_CRITIQUE_DAILY_CAP = 10 as const;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** The `event_type` written by `chargeRebuildCritique` for story
 * critiques. Counted in the shared per-user 10/24h story AI gate.
 */
export const STORY_CRITIQUE_AUDIT_EVENT_TYPE =
  "story_critique.unit_charged" as const;

/** The `event_type` written by `chargeRebuildCritique` for story
 * enhances. Counted alongside `STORY_CRITIQUE_AUDIT_EVENT_TYPE` in
 * the shared per-user 10/24h story AI gate.
 */
export const STORY_ENHANCE_AUDIT_EVENT_TYPE =
  "story_enhance.unit_charged" as const;

/** Both story AI event types that count toward the shared budget. */
const STORY_AI_EVENT_TYPES = [
  STORY_CRITIQUE_AUDIT_EVENT_TYPE,
  STORY_ENHANCE_AUDIT_EVENT_TYPE,
] as const;

export class StoryCritiqueRateLimitError extends Error {
  readonly code = "story_critique_rate_limited";
  readonly limit: number;
  readonly retryAfterSeconds: number;
  constructor(limit: number, retryAfterSeconds: number) {
    super(
      `Story AI rate limit exceeded: ${limit} operations in 24 hours. Try again in ${retryAfterSeconds}s.`,
    );
    this.name = "StoryCritiqueRateLimitError";
    this.limit = limit;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Count story AI operations (critiques + enhances) by this user in
 * the trailing 24 hours. Exported for unit tests and analytics event
 * properties.
 */
export async function countStoryCritiquesInLast24h(
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - ONE_DAY_MS);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.userId, userId),
        inArray(schema.auditLog.eventType, [...STORY_AI_EVENT_TYPES]),
        gte(schema.auditLog.createdAt, cutoff),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Throws `StoryCritiqueRateLimitError` when the user is at or above
 * the 10-per-24h cap. Returns silently otherwise.
 *
 * The route handler maps the throw to 429 with `Retry-After:
 * <retryAfterSeconds>` so a polite client can wait and retry.
 */
export async function assertStoryCritiqueRateOk(
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const count = await countStoryCritiquesInLast24h(userId, now);
  if (count < STORY_CRITIQUE_DAILY_CAP) return;

  // Find the oldest in-window audit row so we can tell the caller
  // exactly when a slot opens. If somehow no row is found (count
  // came from a race that cleared before this query) fall back to
  // 1 hour as a safe upper bound.
  const cutoff = new Date(now.getTime() - ONE_DAY_MS);
  const [oldest] = await db
    .select({ createdAt: schema.auditLog.createdAt })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.userId, userId),
        inArray(schema.auditLog.eventType, [...STORY_AI_EVENT_TYPES]),
        gte(schema.auditLog.createdAt, cutoff),
      ),
    )
    .orderBy(schema.auditLog.createdAt)
    .limit(1);

  const retryAtMs = oldest
    ? oldest.createdAt.getTime() + ONE_DAY_MS
    : now.getTime() + 60 * 60 * 1000;

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((retryAtMs - now.getTime()) / 1000),
  );

  throw new StoryCritiqueRateLimitError(
    STORY_CRITIQUE_DAILY_CAP,
    retryAfterSeconds,
  );
}
