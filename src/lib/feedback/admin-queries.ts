import "server-only";

import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db, schema } from "@/lib/db";
import type { Feedback, FeedbackStatus } from "@/lib/db/schema";

/**
 * Read + write helpers for the admin moderation queue at
 * `/admin/feedback`. This module is the only place admin-side
 * cross-tenant access to `feedback` rows is allowed; the
 * `(admin)` layout already gates `is_admin = true`, so everything
 * here trusts that gate and reads any user's row by id without an
 * ownership filter — same convention as `users-queries.ts`.
 */

export interface AdminFeedbackRow extends Feedback {
  /** Joined-in email of the submitter — driven by the queue UI. */
  submitterEmail: string;
  /** Joined-in display name of the submitter, when set on `users`. */
  submitterDisplayName: string | null;
  /** Joined-in email of the approving admin, when applicable. */
  approverEmail: string | null;
}

export interface ListFeedbackArgs {
  /** `null` returns all statuses (used by the "All" filter chip). */
  status: FeedbackStatus | null;
  limit?: number;
  offset?: number;
}

export interface ListFeedbackResult {
  rows: AdminFeedbackRow[];
  totalCount: number;
}

const DEFAULT_LIMIT = 50;

/**
 * Queue list with submitter + approver joins. The compound index
 * `feedback_status_created_idx` covers the common case (filter by
 * status + sort by created_at DESC) in a single index scan.
 *
 * The approver join uses a `users` alias so the same table can be
 * referenced twice (once for the submitter via the FK
 * `user_id`, once for the approver via `approved_by_user_id`).
 *
 * The total-count is a separate cheap aggregate query rather than
 * a window function so the row-level types stay clean.
 */
export async function listFeedback(
  args: ListFeedbackArgs,
): Promise<ListFeedbackResult> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const offset = args.offset ?? 0;

  const approver = alias(schema.users, "approver");

  const whereClause =
    args.status !== null
      ? eq(schema.feedback.status, args.status)
      : undefined;

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        feedback: schema.feedback,
        submitterEmail: schema.users.email,
        // `users.name` is the schema-level key for the
        // `display_name` SQL column (see `lib/db/schema/users.ts`).
        submitterDisplayName: schema.users.name,
        approverEmail: approver.email,
      })
      .from(schema.feedback)
      .innerJoin(schema.users, eq(schema.users.id, schema.feedback.userId))
      .leftJoin(approver, eq(approver.id, schema.feedback.approvedByUserId))
      .where(whereClause)
      .orderBy(desc(schema.feedback.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.feedback)
      .where(whereClause),
  ]);

  const totalCount = totalRows[0]?.count ?? 0;
  return {
    rows: rows.map((r) => ({
      ...r.feedback,
      submitterEmail: r.submitterEmail,
      submitterDisplayName: r.submitterDisplayName,
      approverEmail: r.approverEmail,
    })),
    totalCount,
  };
}

/**
 * Count rows in each status bucket. Used by the queue UI's filter
 * chips to show "Pending (12) / Approved (5) / Rejected (3)" so
 * the admin sees what's waiting on them without clicking through
 * every chip.
 *
 * One query, GROUP BY status, single round-trip.
 */
export async function countFeedbackByStatus(): Promise<
  Record<FeedbackStatus, number>
> {
  const rows = await db
    .select({
      status: schema.feedback.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.feedback)
    .groupBy(schema.feedback.status);

  const result: Record<FeedbackStatus, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
  };
  for (const row of rows) {
    // The CHECK constraint guarantees `status` is one of the
    // three known values; the cast is safe.
    result[row.status as FeedbackStatus] = row.count;
  }
  return result;
}

/**
 * Transition a row to a new status. The transition matrix is open
 * (any status → any status) so a misclick can be reverted without
 * a separate "unapprove" endpoint. Side effects:
 *
 *   - `approved` target: stamp `approved_at = now()` AND
 *     `approved_by_user_id = adminUserId`.
 *   - Any other target: clear both columns so the partial
 *     testimonials index doesn't surface stale rows after a
 *     reversal.
 *   - `adminNotes` is replaced with the supplied value (use
 *     `null` to clear). `null` is a deliberate signal — the
 *     admin who reverses a decision and wants to KEEP the old
 *     note must pass it back explicitly. This keeps the UI
 *     contract simple ("what you submit IS the new state").
 *
 * Returns the updated row, or `null` when no row matched the id
 * (caller maps to 404).
 */
export async function updateFeedbackStatus(args: {
  id: string;
  status: FeedbackStatus;
  adminUserId: string;
  adminNotes: string | null;
}): Promise<Feedback | null> {
  const { id, status, adminUserId, adminNotes } = args;
  const now = new Date();

  const setClause = {
    status,
    adminNotes,
    updatedAt: now,
    // The two approval-stamp columns track the transition:
    //   - moving TO `approved`: set both to (now, admin).
    //   - moving AWAY from `approved`: clear both so the
    //     partial index `feedback_approved_idx` doesn't keep
    //     surfacing this row.
    approvedAt: status === "approved" ? now : null,
    approvedByUserId: status === "approved" ? adminUserId : null,
    // Cascade: a row that loses its approval also loses its
    // featured slot. The home-page partial index already filters
    // on status='approved', so an un-featured row wouldn't render
    // either way — but explicitly clearing keeps the admin UI
    // honest ("featured" never disagrees with what's on the home
    // page) and matches the schema invariant documented on the
    // `featured` column. A re-approval does NOT auto-restore the
    // slot: the admin must explicitly re-feature.
    ...(status === "approved"
      ? {}
      : { featured: false, featuredOrder: null }),
  };

  const [row] = await db
    .update(schema.feedback)
    .set(setClause)
    .where(eq(schema.feedback.id, id))
    .returning();
  return row ?? null;
}

/**
 * Read a single row by id (for the route handler to fetch the
 * `targetUserId` it needs for the audit-log entry).
 */
export async function getFeedbackById(id: string): Promise<Feedback | null> {
  const [row] = await db
    .select()
    .from(schema.feedback)
    .where(eq(schema.feedback.id, id))
    .limit(1);
  return row ?? null;
}

/* ────────────────────────────────────────────────────────────── */
/* Curation / "featured" surface                                  */
/*                                                                */
/* The home-page testimonials section reads featured rows via     */
/* `getApprovedTestimonials` in `src/lib/feedback/queries.ts`.    */
/* The helpers below drive the admin UI that decides which rows   */
/* are featured and in what order. The cap is enforced at the API */
/* layer (see `FEATURED_TESTIMONIALS_MAX` in schemas.ts).         */
/* ────────────────────────────────────────────────────────────── */

export interface FeaturedFeedbackRow extends Feedback {
  /** Joined-in email of the submitter. */
  submitterEmail: string;
  /** Joined-in display name of the submitter, when set on `users`. */
  submitterDisplayName: string | null;
}

/**
 * Return all currently-featured rows in display order (lowest
 * `featured_order` first, with `approved_at DESC` as tiebreaker).
 *
 * Includes submitter joins so the admin "Featured" section can show
 * who's queued up without a second round-trip. Bounded by
 * `FEATURED_TESTIMONIALS_MAX` (the cap is enforced on the write
 * side; this query is defensive and reads everything featured so a
 * misconfigured DB doesn't silently hide rows).
 */
export async function listFeaturedFeedback(): Promise<FeaturedFeedbackRow[]> {
  const rows = await db
    .select({
      feedback: schema.feedback,
      submitterEmail: schema.users.email,
      submitterDisplayName: schema.users.name,
    })
    .from(schema.feedback)
    .innerJoin(schema.users, eq(schema.users.id, schema.feedback.userId))
    .where(eq(schema.feedback.featured, true))
    .orderBy(
      asc(schema.feedback.featuredOrder),
      desc(schema.feedback.approvedAt),
    );

  return rows.map((r) => ({
    ...r.feedback,
    submitterEmail: r.submitterEmail,
    submitterDisplayName: r.submitterDisplayName,
  }));
}

/**
 * Count of currently-featured rows. Used by the cap check in the
 * Feature route and by the admin page's header to show "(N/6)".
 * Cheap aggregate; the partial index makes the row scan minimal.
 */
export async function countFeaturedFeedback(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.feedback)
    .where(eq(schema.feedback.featured, true));
  return row?.count ?? 0;
}

/**
 * Mark a row as featured and append it to the end of the display
 * order (max(existing) + 1, or 1 when nothing is featured yet).
 *
 * Returns `null` if the row doesn't exist OR if it fails the
 * featuring preconditions (status='approved' AND consent_public=true).
 * The CHECK constraint added in migration 0030 is the DB-level
 * backstop — this read-then-write pattern returns a clean error
 * before hitting that constraint.
 *
 * The cap check (max 6) lives in the route handler, not here, so
 * this helper is reusable by future surfaces that might bypass the
 * cap (e.g. a "preview" mode).
 */
export async function featureFeedback(args: {
  id: string;
}): Promise<Feedback | null> {
  const existing = await getFeedbackById(args.id);
  if (!existing) return null;
  if (existing.featured) return existing; // Idempotent.
  if (existing.status !== "approved" || !existing.consentPublic) {
    return null;
  }

  // Use a CTE-like aggregate to find max(featured_order). Done
  // inside a transaction so a concurrent feature call can't pick
  // the same slot (defence in depth — the partial unique index
  // isn't enforced, but a race here would still produce two rows
  // at the same order which is just a tie, not a corruption).
  const [maxRow] = await db
    .select({
      max: sql<number | null>`MAX(${schema.feedback.featuredOrder})`,
    })
    .from(schema.feedback)
    .where(eq(schema.feedback.featured, true));
  const nextOrder = (maxRow?.max ?? 0) + 1;

  const [row] = await db
    .update(schema.feedback)
    .set({
      featured: true,
      featuredOrder: nextOrder,
      updatedAt: new Date(),
    })
    .where(eq(schema.feedback.id, args.id))
    .returning();
  return row ?? null;
}

/**
 * Mark a row as no longer featured. Clears both `featured` and
 * `featured_order` (the CHECK constraint demands they move
 * together).
 *
 * Returns `null` when the row doesn't exist. Idempotent: calling on
 * an already-unfeatured row is a no-op and returns the row.
 */
export async function unfeatureFeedback(args: {
  id: string;
}): Promise<Feedback | null> {
  const existing = await getFeedbackById(args.id);
  if (!existing) return null;
  if (!existing.featured) return existing; // Idempotent.

  const [row] = await db
    .update(schema.feedback)
    .set({
      featured: false,
      featuredOrder: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.feedback.id, args.id))
    .returning();
  return row ?? null;
}

export interface MoveFeaturedResult {
  row: Feedback;
  /** True if a swap happened, false if the row was already at the
   *  edge of the list (no-op, returned for UI feedback). */
  swapped: boolean;
  /** When swapped, the other row whose order changed. Useful for
   *  the audit log so a replay knows both endpoints. */
  swappedWith: Feedback | null;
}

/**
 * Swap a featured row with its neighbour in the requested direction.
 *
 * `"up"`   = swap with the row immediately ABOVE in display order
 *            (lower `featured_order`).
 * `"down"` = swap with the row immediately BELOW in display order
 *            (higher `featured_order`).
 *
 * If the target row is already at the start (for "up") or end (for
 * "down") of the list, the function returns `swapped=false` and the
 * row unchanged — the API surfaces this as a 200 no-op so the
 * client UX doesn't have to disable arrows at the boundaries
 * (the admin can keep clicking; nothing breaks).
 *
 * Implementation: two UPDATEs in a transaction. The ordering is
 * NOT enforced unique by the schema, so even without the
 * transaction the worst case is a brief tie (broken by approved_at
 * DESC). The transaction is for atomicity of the "both moved or
 * neither" contract.
 */
export async function moveFeaturedFeedback(args: {
  id: string;
  direction: "up" | "down";
}): Promise<MoveFeaturedResult | null> {
  const existing = await getFeedbackById(args.id);
  if (!existing) return null;
  if (!existing.featured || existing.featuredOrder === null) {
    // Caller bug or stale UI — surface as 404-ish so the route
    // can refresh and recover.
    return null;
  }

  return await db.transaction(async (tx) => {
    const direction = args.direction;
    // Find the immediate neighbour in the requested direction.
    const neighbour = await tx
      .select()
      .from(schema.feedback)
      .where(
        and(
          eq(schema.feedback.featured, true),
          direction === "up"
            ? lt(schema.feedback.featuredOrder, existing.featuredOrder!)
            : gt(schema.feedback.featuredOrder, existing.featuredOrder!),
        ),
      )
      .orderBy(
        direction === "up"
          ? desc(schema.feedback.featuredOrder)
          : asc(schema.feedback.featuredOrder),
      )
      .limit(1);

    const neighbourRow = neighbour[0];
    if (!neighbourRow) {
      // Already at the boundary — no-op, return the unchanged row.
      return { row: existing, swapped: false, swappedWith: null };
    }

    const now = new Date();
    // Swap the two featured_order values. Two single-row UPDATEs.
    const [updatedSelf] = await tx
      .update(schema.feedback)
      .set({
        featuredOrder: neighbourRow.featuredOrder,
        updatedAt: now,
      })
      .where(eq(schema.feedback.id, existing.id))
      .returning();
    const [updatedNeighbour] = await tx
      .update(schema.feedback)
      .set({
        featuredOrder: existing.featuredOrder,
        updatedAt: now,
      })
      .where(eq(schema.feedback.id, neighbourRow.id))
      .returning();

    if (!updatedSelf || !updatedNeighbour) {
      // Lost a race; transaction rolls back automatically when we
      // throw, so the partial swap doesn't land.
      throw new Error("moveFeaturedFeedback: swap UPDATE returned no row");
    }

    return {
      row: updatedSelf,
      swapped: true,
      swappedWith: updatedNeighbour,
    };
  });
}
