import "server-only";

import { headers } from "next/headers";

import { db, schema } from "@/lib/db";

/**
 * Audit-log helpers for the `(admin)` route group.
 *
 * Two write paths funnel through here so the event-type strings stay
 * grep-able and consistent (drift in a string literal is how an admin
 * action goes "missing" from a forensic search):
 *
 *   - `recordAdminPageView`  — every admin page load. The (admin)
 *     layout calls this BEFORE rendering the page, so a request that
 *     fails the is_admin gate never produces a misleading "viewed"
 *     row.
 *
 *   - `recordAdminAction`    — every state-changing admin action
 *     (grant credits, refund, add note, delete note). The action
 *     handler must call this inside the same DB transaction as the
 *     change itself, so a write failure that rolls back the action
 *     also rolls back the audit row (no false-positive "they granted
 *     credits" rows for actions that never landed).
 *
 * The `audit_log` table itself is append-only by convention (we never
 * UPDATE or DELETE rows in application code). Enforcement is by code
 * review + the partial index on (event_type, created_at desc) which
 * makes forensic reads cheap regardless of table size.
 *
 * IP + user-agent are pulled from request headers via the
 * `withRequestContext` overload below — that overload is the one
 * Server Actions and API handlers should call so the resulting row
 * carries the network attribution the runbook expects.
 */

export const ADMIN_AUDIT_EVENTS = {
  pageViewed: "admin_page_viewed",
  // Each `admin_action.*` event is its own string so a forensic
  // search ("show me every credit grant") doesn't have to filter
  // a generic `admin_action` row by `event_data->>'action_type'`.
  // Adding a new admin action is a one-line diff here AND a `tsc`
  // error at the call site because `AdminActionType` is a union.
  actionGrantCredits: "admin_action.grant_credits",
  actionRefund: "admin_action.refund",
  actionNoteCreated: "admin_action.note_created",
  actionNoteDeleted: "admin_action.note_deleted",
  // Moderation surface for the feedback widget. Distinct event
  // strings for each status transition so a forensic search can
  // answer "what did we approve last week" without filtering on
  // event_data.
  actionFeedbackApproved: "admin_action.feedback_approved",
  actionFeedbackRejected: "admin_action.feedback_rejected",
  actionFeedbackUnreviewed: "admin_action.feedback_unreviewed",
  // Curation surface — the second-stage gate that picks which
  // approved testimonials actually surface on the marketing home
  // page. Featured and Unfeatured are distinct so the home-page
  // visibility forensic story is grep-able. Reordered carries the
  // old/new featured_order in event_data for replay.
  actionFeedbackFeatured: "admin_action.feedback_featured",
  actionFeedbackUnfeatured: "admin_action.feedback_unfeatured",
  actionFeedbackReordered: "admin_action.feedback_reordered",
} as const;

export type AdminActionType = Exclude<
  (typeof ADMIN_AUDIT_EVENTS)[keyof typeof ADMIN_AUDIT_EVENTS],
  typeof ADMIN_AUDIT_EVENTS.pageViewed
>;

interface PageViewArgs {
  adminId: string;
  /** Path the admin requested, e.g. `/admin/ops`. */
  path: string;
  /**
   * For the user-detail surface, the user being inspected. Lets a
   * forensic search answer "who looked at this user's record". NULL
   * for surfaces that aren't user-scoped (Ops, Health, Users index).
   */
  viewedUserId?: string | null;
}

/**
 * Best-effort write of an `admin_page_viewed` row. Pulls IP +
 * user-agent from the request headers via `next/headers` so the
 * forensic row carries network context without the caller having to
 * thread headers through every page component.
 *
 * Catches and swallows errors with a console log: a transient DB
 * blip MUST NOT block the admin from seeing their own dashboard.
 * The page-view event is best-effort by design.
 */
export async function recordAdminPageView(args: PageViewArgs): Promise<void> {
  try {
    const { ip, userAgent } = await readRequestContext();
    await db.insert(schema.auditLog).values({
      userId: args.adminId,
      eventType: ADMIN_AUDIT_EVENTS.pageViewed,
      eventData: {
        path: args.path,
        viewedUserId: args.viewedUserId ?? null,
      },
      ipAddress: ip ?? undefined,
      userAgent: userAgent ?? undefined,
    });
  } catch (err) {
    console.error("[admin/audit] page-view write failed:", err);
  }
}

interface AdminActionArgs {
  adminId: string;
  action: AdminActionType;
  /** The user the action targets (always set for v1 actions). */
  targetUserId: string;
  /** Action-specific metadata. Stored in `event_data.details`. */
  details: Record<string, unknown>;
}

/**
 * Write an admin-action audit row. Unlike `recordAdminPageView`,
 * this MUST NOT swallow errors — a failed audit write means the
 * action wasn't properly recorded, and the caller's wrapping
 * transaction should roll back. Run this INSIDE the same `db.transaction`
 * as the state-changing write so the two land or fail together.
 */
export async function recordAdminAction(args: AdminActionArgs): Promise<void> {
  const { ip, userAgent } = await readRequestContext();
  await db.insert(schema.auditLog).values({
    userId: args.adminId,
    eventType: args.action,
    eventData: {
      targetUserId: args.targetUserId,
      details: args.details,
    },
    ipAddress: ip ?? undefined,
    userAgent: userAgent ?? undefined,
  });
}

interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Pull caller IP + user-agent from `next/headers`. Works in Server
 * Components (the admin layout uses it) and Server Actions / route
 * handlers. Returns `{ ip: null, userAgent: null }` when invoked
 * outside a request scope (e.g. a background job) so callers don't
 * have to special-case that path.
 */
async function readRequestContext(): Promise<RequestContext> {
  try {
    const h = await headers();
    // x-forwarded-for can be a comma-separated chain (the leftmost
    // value is the original client). We only want the first hop.
    const forwarded = h.get("x-forwarded-for");
    const ip =
      forwarded?.split(",")[0]?.trim() ||
      h.get("x-real-ip") ||
      null;
    const userAgent = h.get("user-agent");
    return { ip, userAgent };
  } catch {
    return { ip: null, userAgent: null };
  }
}
