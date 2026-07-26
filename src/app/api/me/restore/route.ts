import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { restoreAccount } from "@/lib/compliance";
import { accountManagementLimiter, ipFromHeaders } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";

/**
 * POST /api/me/restore
 *
 * Cancels a pending deletion if (and only if) we're still inside
 * the 30-day grace window.
 *
 * Auth note: this endpoint deliberately uses the bare `auth()`
 * helper instead of `getActiveUserId`. The latter filters out users
 * with `deleted_at IS NOT NULL` — exactly the population this
 * endpoint exists to serve. The same-origin guard + a fresh JWT is
 * the security boundary; the soft-deleted user is the intended
 * caller.
 *
 * Past the 30-day window the row is in the cron's queue and we
 * return 410 Gone — we don't try to undo a hard-delete in flight
 * because we don't know whether the cron has already started. The
 * email/transcript surface is gone; the financial ledger is
 * anonymized; nothing useful would come of "restoring" the row.
 */

export async function POST(request: Request): Promise<Response> {
  const h = await headers();

  if (!isSameOrigin(h)) {
    return NextResponse.json(
      { error: "forbidden", message: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "You must be signed in." },
      { status: 401 },
    );
  }

  // Same shared limiter as DELETE /api/me — restore + delete are
  // the same "account state machine" operation from the user's POV
  // and a flapping client should be bounced regardless of which
  // verb it's hammering.
  const limit = await accountManagementLimiter().check(userId);
  if (!limit.success) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message:
          "Too many account changes. Please wait a moment and try again.",
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))),
        },
      },
    );
  }

  const result = await restoreAccount({
    userId,
    ipAddress: ipFromHeaders(h),
    userAgent: h.get("user-agent"),
  });

  if (!result.ok) {
    if (result.reason === "expired") {
      return NextResponse.json(
        {
          error: "gone",
          message:
            "Your account is past the 30-day restore window and is being permanently deleted.",
        },
        { status: 410 },
      );
    }
    if (result.reason === "user_missing") {
      return NextResponse.json(
        { error: "not_found", message: "User not found." },
        { status: 404 },
      );
    }
    // not_pending — the user wasn't actually in the deletion queue.
    // Return 200 because from the client's perspective the desired
    // end state is reached.
    return NextResponse.json(
      { ok: true, alreadyActive: true },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  void request;

  return NextResponse.json(
    { ok: true, restoredAt: result.restoredAt.toISOString() },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
