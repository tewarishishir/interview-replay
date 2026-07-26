import "server-only";

import { and, desc, eq, ne, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { RebuildStatus, StoryRebuild } from "@/lib/db/schema";

/**
 * Read-side queries for the Practice Rebuild feature.
 *
 * Every query takes `userId` and pins the WHERE on it. The same
 * pattern as `queries/profiles.ts` and `queries/sessions.ts`: we
 * never expose a "by id only" lookup so cross-tenant data leaks
 * become impossible to write by accident.
 */

/**
 * Fetch one rebuild iff it belongs to the given user. Returns
 * `null` for both "not found" and "owned by someone else".
 */
export async function getRebuild(
  rebuildId: string,
  userId: string,
): Promise<StoryRebuild | null> {
  const [row] = await db
    .select()
    .from(schema.storyRebuilds)
    .where(
      and(
        eq(schema.storyRebuilds.id, rebuildId),
        eq(schema.storyRebuilds.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface ListRebuildsArgs {
  userId: string;
  status?: RebuildStatus;
  /**
   * Filter to rebuilds attached to a specific source session.
   * Used by the report view to render "you've already started a
   * rebuild for this improvement" badges per-improvement.
   */
  sessionId?: string;
  limit?: number;
}

/**
 * Paginated list of a user's rebuilds, newest-first by
 * `updated_at`. Hits `story_rebuilds_user_updated_idx`.
 *
 * The default behaviour intentionally hides `discarded` rebuilds
 * (they're soft-deleted and the dashboard / list page should not
 * surface them). To explicitly list discarded rows, pass
 * `status: 'discarded'`.
 */
export async function listRebuilds(
  args: ListRebuildsArgs,
): Promise<StoryRebuild[]> {
  const limit = Math.max(1, Math.min(100, args.limit ?? 50));

  // Build the WHERE inline so the type narrows correctly. The
  // default "exclude discarded" branch uses `ne(..., 'discarded')`
  // — this maps onto `story_rebuilds_user_status_idx`, the partial
  // index that already excludes discarded rows.
  const filters = [eq(schema.storyRebuilds.userId, args.userId)];
  if (args.status) {
    filters.push(eq(schema.storyRebuilds.status, args.status));
  } else {
    filters.push(ne(schema.storyRebuilds.status, "discarded"));
  }
  if (args.sessionId) {
    filters.push(eq(schema.storyRebuilds.sourceSessionId, args.sessionId));
  }

  return db
    .select()
    .from(schema.storyRebuilds)
    .where(and(...filters))
    .orderBy(desc(schema.storyRebuilds.updatedAt))
    .limit(limit);
}

/**
 * Count of in-flight rebuilds (status NOT IN ('saved_to_bank',
 * 'discarded')) for the dashboard badge. Hits
 * `story_rebuilds_user_status_idx`.
 */
export async function countInFlightRebuilds(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.storyRebuilds)
    .where(
      and(
        eq(schema.storyRebuilds.userId, userId),
        sql`${schema.storyRebuilds.status} NOT IN ('saved_to_bank', 'discarded')`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Convenience: rebuilds attached to a given source session. Used
 * by the report view's "Strengthen your story bank" section to
 * cross-check whether a user has already started rebuilding any
 * of the improvements we're about to suggest.
 *
 * Returns at most 50 rows (the FK index is covered by
 * `story_rebuilds_session_idx` so this is cheap).
 */
export async function listRebuildsForSession(args: {
  sessionId: string;
  userId: string;
}): Promise<StoryRebuild[]> {
  return db
    .select()
    .from(schema.storyRebuilds)
    .where(
      and(
        eq(schema.storyRebuilds.sourceSessionId, args.sessionId),
        eq(schema.storyRebuilds.userId, args.userId),
        ne(schema.storyRebuilds.status, "discarded"),
      ),
    )
    .orderBy(desc(schema.storyRebuilds.updatedAt))
    .limit(50);
}

/**
 * Idempotency lookup for POST `/api/rebuilds`. Returns the user's
 * existing in-flight rebuild for the same
 * (source_session_id, source_improvement_index) pair, or null when
 * none exists. Used so a user double-clicking "Rebuild a story for
 * this →" doesn't accumulate a pile of empty in_progress rebuilds
 * pointing at the same improvement.
 *
 * Filters on `status='in_progress'` (not just non-discarded): if
 * the user already critiqued or saved a rebuild for this
 * improvement, the next click should start a fresh rebuild —
 * they're explicitly opting to redo the work.
 *
 * Both arguments are required; a standalone (no source session)
 * rebuild is unique per click and shouldn't be deduped.
 */
export async function findInProgressRebuildForImprovement(args: {
  userId: string;
  sourceSessionId: string;
  sourceImprovementIndex: number | null;
}): Promise<StoryRebuild | null> {
  const filters = [
    eq(schema.storyRebuilds.userId, args.userId),
    eq(schema.storyRebuilds.sourceSessionId, args.sourceSessionId),
    eq(schema.storyRebuilds.status, "in_progress"),
  ];
  if (args.sourceImprovementIndex == null) {
    filters.push(sql`${schema.storyRebuilds.sourceImprovementIndex} IS NULL`);
  } else {
    filters.push(
      eq(
        schema.storyRebuilds.sourceImprovementIndex,
        args.sourceImprovementIndex,
      ),
    );
  }
  const [row] = await db
    .select()
    .from(schema.storyRebuilds)
    .where(and(...filters))
    .orderBy(desc(schema.storyRebuilds.createdAt))
    .limit(1);
  return row ?? null;
}
