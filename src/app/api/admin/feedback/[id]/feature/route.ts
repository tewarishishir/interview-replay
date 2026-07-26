import { NextResponse } from "next/server";

import { getAdminUser } from "@/lib/admin/auth";
import {
  ADMIN_AUDIT_EVENTS,
  recordAdminAction,
} from "@/lib/admin/audit";
import {
  countFeaturedFeedback,
  featureFeedback,
  getFeedbackById,
  unfeatureFeedback,
} from "@/lib/feedback/admin-queries";
import {
  FEATURED_TESTIMONIALS_MAX,
  feedbackAdminFeatureSchema,
} from "@/lib/feedback/schemas";

/**
 * `POST /api/admin/feedback/[id]/feature` — toggle a row's home-page
 * featured state. Body: `{ featured: boolean }`.
 *
 * Preconditions enforced here (defence in depth — the DB CHECK
 * constraint catches the consent half, but a clean 409 is friendlier
 * than a 500 from a constraint violation):
 *
 *   - `featured=true` requires the row to be `status='approved'`
 *     AND `consent_public=true`. Otherwise 409 with a clear
 *     `error: 'precondition_failed'` body.
 *   - `featured=true` is capped at `FEATURED_TESTIMONIALS_MAX` rows
 *     in total. At the cap, the route returns 409 with
 *     `error: 'featured_cap_reached'`. The client surfaces this
 *     inline so the admin knows to unfeature something first.
 *
 * Idempotency: featuring an already-featured row OR unfeaturing an
 * already-unfeatured row returns 200 with the current state.
 *
 * Audit row carries the SUBMITTER's user id so a forensic search
 * for "who curated this user's feedback onto the home page" works
 * by `targetUserId`, mirroring the rest of the feedback moderation
 * API.
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

  const parsed = feedbackAdminFeatureSchema.safeParse(body);
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

  // Pre-fetch the row for the audit-row submitter id and to
  // pre-check the preconditions before doing the UPDATE.
  const existing = await getFeedbackById(id);
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // The two action paths share auth + validation but diverge here:
  //   - featured=true: precondition check → cap check → write
  //   - featured=false: write
  if (parsed.data.featured) {
    if (existing.status !== "approved" || !existing.consentPublic) {
      return NextResponse.json(
        {
          error: "precondition_failed",
          message:
            "Only approved rows with consent_public=true can be featured.",
        },
        { status: 409 },
      );
    }

    // Cap check: a row that's ALREADY featured doesn't push past
    // the cap (idempotent). For not-yet-featured rows, compare
    // against the cap directly.
    if (!existing.featured) {
      const currentCount = await countFeaturedFeedback();
      if (currentCount >= FEATURED_TESTIMONIALS_MAX) {
        return NextResponse.json(
          {
            error: "featured_cap_reached",
            message: `The home page caps featured testimonials at ${FEATURED_TESTIMONIALS_MAX}. Unfeature one to make room.`,
          },
          { status: 409 },
        );
      }
    }

    const updated = await featureFeedback({ id });
    if (!updated) {
      // featureFeedback returns null on missing row OR failed
      // precondition. We already checked both above, so this is a
      // lost-race condition (concurrent admin demoted the row
      // between our reads). Surface as 404 and let the queue UI
      // refresh.
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    try {
      await recordAdminAction({
        adminId: admin.id,
        action: ADMIN_AUDIT_EVENTS.actionFeedbackFeatured,
        targetUserId: existing.userId,
        details: {
          feedbackId: id,
          featuredOrder: updated.featuredOrder,
        },
      });
    } catch (err) {
      console.error(
        "[POST /api/admin/feedback/[id]/feature] audit write failed:",
        err,
      );
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // featured=false
  const updated = await unfeatureFeedback({ id });
  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    await recordAdminAction({
      adminId: admin.id,
      action: ADMIN_AUDIT_EVENTS.actionFeedbackUnfeatured,
      targetUserId: existing.userId,
      details: {
        feedbackId: id,
        previousOrder: existing.featuredOrder,
      },
    });
  } catch (err) {
    console.error(
      "[POST /api/admin/feedback/[id]/feature] audit write failed:",
      err,
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
