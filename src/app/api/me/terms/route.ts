import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { getActiveUserId } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { accountManagementLimiter, ipFromHeaders } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";

/**
 * POST /api/me/terms
 *
 * Records the user's acceptance of the current Terms of Service +
 * Privacy Policy. The (app) layout reads `users.terms_accepted_at`,
 * compares it against `TERMS_VERSION_DATE` from
 * `lib/compliance/constants`, and renders a blocking modal until
 * this endpoint flips the column.
 *
 * No payload — the act of POSTing IS the acceptance. This keeps
 * the surface tiny and prevents a forged client from claiming
 * acceptance of a terms version that doesn't exist.
 */

export async function POST(): Promise<Response> {
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

  // Same shared limiter as the rest of /api/me/* — a stuck client
  // re-POSTing this every 100 ms shouldn't grow the audit table.
  const limit = await accountManagementLimiter().check(userId);
  if (!limit.success) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many requests. Please wait a moment and try again.",
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))),
        },
      },
    );
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(schema.users)
      .set({ termsAcceptedAt: now, updatedAt: now })
      .where(eq(schema.users.id, userId));

    await tx.insert(schema.auditLog).values({
      userId,
      eventType: "terms.accepted",
      eventData: {
        // We don't store the user-agent term version here because
        // the version is inferred from the timestamp + the deployed
        // `TERMS_VERSION_DATE`; a future "ToS history" page can
        // reconstruct which version was current when this row
        // landed.
      },
      ipAddress: ipFromHeaders(h),
      userAgent: h.get("user-agent"),
    });
  });

  return NextResponse.json(
    { ok: true, acceptedAt: now.toISOString() },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
