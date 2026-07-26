import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { signOut } from "@/lib/auth";
import { getActiveUserId } from "@/lib/auth/session";
import {
  describeDeletionState,
  initiateAccountDeletion,
} from "@/lib/compliance";
import { db, schema } from "@/lib/db";
import { sendAccountDeletionInitiatedEmail } from "@/lib/email";
import { accountManagementLimiter, ipFromHeaders } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { eq } from "drizzle-orm";

/**
 * /api/me — account-level operations.
 *
 *   GET    : whoami summary used by the account page (display name,
 *            email, deletion state). NOT a substitute for `auth()` —
 *            this just bundles a few fields the UI needs.
 *
 *   DELETE : initiate the 30-day deletion grace period. Stamps
 *            `deleted_at` + `deletion_requested_at`, sends the
 *            "you can sign back in to cancel" email, and signs the
 *            user out (so the browser bounces to /signin and the
 *            stale JWT can't keep accessing the app).
 *
 * The restore endpoint lives at `/api/me/restore` (separate file)
 * because it has unusual auth semantics — it must accept calls
 * from the credentials sign-in path BEFORE a session exists.
 */

export async function GET(): Promise<Response> {
  const userId = await getActiveUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "You must be signed in." },
      { status: 401 },
    );
  }

  const [row] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      creditBalance: schema.users.creditBalance,
      createdAt: schema.users.createdAt,
      deletedAt: schema.users.deletedAt,
      deletionRequestedAt: schema.users.deletionRequestedAt,
      termsAcceptedAt: schema.users.termsAcceptedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { error: "not_found", message: "User not found." },
      { status: 404 },
    );
  }

  const deletionState = describeDeletionState({
    deletedAt: row.deletedAt,
    deletionRequestedAt: row.deletionRequestedAt,
  });

  return NextResponse.json(
    {
      user: {
        id: row.id,
        email: row.email,
        name: row.name,
        creditBalance: row.creditBalance,
        createdAt: row.createdAt.toISOString(),
        termsAcceptedAt: row.termsAcceptedAt?.toISOString() ?? null,
      },
      deletion: {
        pending: deletionState.pending,
        requestedAt: deletionState.requestedAt?.toISOString() ?? null,
        hardDeleteAt: deletionState.hardDeleteAt?.toISOString() ?? null,
      },
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * DELETE /api/me
 *
 * Spec: initiate 30-day grace period, set `deleted_at = now()`,
 * sign user out (delete Auth.js session), email the cancel-by
 * notice. The hard-delete-accounts cron handles the actual
 * destruction 30 days later.
 */
export async function DELETE(request: Request): Promise<Response> {
  const h = await headers();

  if (!isSameOrigin(h)) {
    return NextResponse.json(
      { error: "forbidden", message: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  const userId = await getActiveUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "You must be signed in." },
      { status: 401 },
    );
  }

  // Bounces a runaway client (or a stolen JWT trying to grief the
  // audit log) BEFORE we reach the email + signOut side effects.
  // Keyed by userId since the route is auth-gated.
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

  // Look up the email up front — `initiateAccountDeletion` doesn't
  // return it, and after we sign the user out the layout filter
  // (`getDashboardUser` excludes soft-deleted) means a follow-up
  // read would 401.
  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!user) {
    return NextResponse.json(
      { error: "not_found", message: "User not found." },
      { status: 404 },
    );
  }

  const result = await initiateAccountDeletion({
    userId,
    ipAddress: ipFromHeaders(h),
    userAgent: h.get("user-agent"),
  });

  // Send the email BEFORE signing the user out so a transient
  // signOut error doesn't leave them without a notification of
  // what's about to happen.
  if (!result.alreadyPending) {
    try {
      await sendAccountDeletionInitiatedEmail({
        to: user.email,
        hardDeleteAt: result.hardDeleteAt,
      });
    } catch (err) {
      // Email failure is logged but doesn't fail the request — the
      // user already saw the confirmation in the UI and the audit
      // log row was written.
      console.error("[/api/me DELETE] notification email failed:", err);
    }
  }

  // Sign out: drops the Auth.js cookie so the next request bounces
  // to /signin. We pass `redirect: false` because this is an API
  // route — the client-side `fetch` will follow up with a hard
  // navigation to /signin.
  try {
    await signOut({ redirect: false });
  } catch (err) {
    // signOut throws NEXT_REDIRECT internally even when redirect:false
    // is set in some versions. The cookie has been cleared either
    // way; log and continue so the response carries the deletion
    // confirmation.
    console.error("[/api/me DELETE] signOut error (cookie still cleared):", err);
  }

  // Avoid `_request` lint by referencing it.
  void request;

  return NextResponse.json(
    {
      ok: true,
      hardDeleteAt: result.hardDeleteAt.toISOString(),
      alreadyPending: result.alreadyPending,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
