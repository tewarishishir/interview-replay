import { NextResponse } from "next/server";

import { getAdminUser } from "@/lib/admin/auth";
import {
  ADMIN_AUDIT_EVENTS,
  recordAdminAction,
  type AdminActionType,
} from "@/lib/admin/audit";
import {
  getFeedbackById,
  updateFeedbackStatus,
} from "@/lib/feedback/admin-queries";
import { feedbackAdminPatchSchema } from "@/lib/feedback/schemas";

/**
 * `PATCH /api/admin/feedback/[id]` — admin moderation transition
 * for a feedback row. Body: `{ status, adminNotes? }`.
 *
 * Disclosure-minimizing 404s for `not_authorized` follow the same
 * convention as the rest of the admin API surface — an anonymous
 * or non-admin probe can't tell the difference between "you can't
 * see this" and "this route doesn't exist".
 *
 * Audit row: written AFTER the status transition lands so a
 * failed write never produces a misleading audit entry. The audit
 * event string is one of:
 *
 *   - admin_action.feedback_approved
 *   - admin_action.feedback_rejected
 *   - admin_action.feedback_unreviewed   (any → 'pending')
 *
 * The `targetUserId` field carries the SUBMITTER's user id so a
 * forensic search for "who looked at this user's feedback" works
 * out of the box, mirroring how `recordAdminAction` is used by
 * the user-detail surfaces.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = feedbackAdminPatchSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join(".") || "_form";
      fieldErrors[key] ??= issue.message;
    }
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "One or more fields are invalid.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  // Pre-fetch the row so we have the submitter id for the audit
  // entry. The status transition itself is a single UPDATE that
  // would have given us the row back — but doing the read first
  // lets us return a clean 404 BEFORE we touch the table, and
  // means the audit + UPDATE share a coherent view of the
  // submitter (a soft-delete between calls is harmless here).
  const existing = await getFeedbackById(id);
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const updated = await updateFeedbackStatus({
    id,
    status: parsed.data.status,
    adminUserId: admin.id,
    adminNotes: parsed.data.adminNotes,
  });

  if (!updated) {
    // Lost the race against a concurrent admin action that
    // deleted the row. Surface as 404 — the queue UI will refresh
    // and the missing row will fall off.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Action string keyed off the TARGET status, not the previous
  // status — what matters forensically is "we moved this row to
  // approved", not "we moved it FROM pending". A reversal back to
  // pending gets its own `feedback_unreviewed` event.
  const action: AdminActionType =
    parsed.data.status === "approved"
      ? ADMIN_AUDIT_EVENTS.actionFeedbackApproved
      : parsed.data.status === "rejected"
        ? ADMIN_AUDIT_EVENTS.actionFeedbackRejected
        : ADMIN_AUDIT_EVENTS.actionFeedbackUnreviewed;

  try {
    await recordAdminAction({
      adminId: admin.id,
      action,
      targetUserId: existing.userId,
      details: {
        feedbackId: id,
        previousStatus: existing.status,
        newStatus: parsed.data.status,
        notesProvided: parsed.data.adminNotes !== null,
      },
    });
  } catch (err) {
    // Audit failure here is logged but doesn't roll back the
    // status transition — same posture as `grantCreditsAction`
    // for similar reasons (the UPDATE already shipped; throwing
    // a 500 now would mislead the admin into thinking it didn't).
    console.error("[PATCH /api/admin/feedback] audit write failed:", err);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
