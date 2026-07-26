import { NextResponse } from "next/server";

import { getAdminUser } from "@/lib/admin/auth";
import {
  ADMIN_AUDIT_EVENTS,
  recordAdminAction,
} from "@/lib/admin/audit";
import {
  getFeedbackById,
  moveFeaturedFeedback,
} from "@/lib/feedback/admin-queries";
import { feedbackAdminMoveSchema } from "@/lib/feedback/schemas";

/**
 * `POST /api/admin/feedback/[id]/move` — nudge a featured row up or
 * down in the home-page display order. Body: `{ direction: 'up' |
 * 'down' }`.
 *
 * Implemented as a swap with the immediate neighbour in the
 * requested direction. The function in
 * `moveFeaturedFeedback` does the transactional two-UPDATE swap
 * and returns `{ swapped: false }` when the row is already at the
 * start/end of the list — in that case the route returns 200
 * (idempotent) so the client UX doesn't have to disable arrows at
 * the boundaries.
 *
 * Returns 404 when the row doesn't exist OR isn't currently
 * featured (the client should refresh and reconcile — likely a
 * concurrent admin un-featured it).
 *
 * Audit row carries old + new `featured_order` so a forensic
 * replay can reconstruct the display order over time.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
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

  const parsed = feedbackAdminMoveSchema.safeParse(body);
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

  // Pre-fetch for the audit row's `targetUserId` and for the
  // old `featured_order` we want to log even on a no-op.
  const existing = await getFeedbackById(id);
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await moveFeaturedFeedback({
    id,
    direction: parsed.data.direction,
  });

  if (!result) {
    // Either the row vanished or it isn't featured anymore.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Only audit when an actual swap happened — a no-op at the
  // boundary isn't a state change worth logging (and would
  // pollute the forensic timeline with click noise).
  if (result.swapped) {
    try {
      await recordAdminAction({
        adminId: admin.id,
        action: ADMIN_AUDIT_EVENTS.actionFeedbackReordered,
        targetUserId: existing.userId,
        details: {
          feedbackId: id,
          direction: parsed.data.direction,
          previousOrder: existing.featuredOrder,
          newOrder: result.row.featuredOrder,
          swappedWithId: result.swappedWith?.id ?? null,
        },
      });
    } catch (err) {
      console.error(
        "[POST /api/admin/feedback/[id]/move] audit write failed:",
        err,
      );
    }
  }

  return NextResponse.json(
    { ok: true, swapped: result.swapped },
    { status: 200 },
  );
}
