import "server-only";

import { cache } from "react";
import { and, eq, isNull } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";

/**
 * Per-request admin gate.
 *
 * Returns the admin user row if the caller is signed in AND
 * `users.is_admin = true` AND the row isn't soft-deleted. Returns
 * `null` for everyone else — including authenticated but non-admin
 * users. The `(admin)` layout treats `null` as "redirect to
 * /dashboard with no message" (don't leak admin URL existence).
 *
 * Why a fresh DB lookup on every request:
 *   - We don't cache `is_admin` on the JWT. A revoked admin (the
 *     SQL `UPDATE users SET is_admin = false` path) must lose
 *     access on the next request, not at the next JWT rotation.
 *     This is the same defense-in-depth pattern the (app) layout
 *     uses with `getDashboardUser` for the soft-delete revocation
 *     check; one indexed PK lookup is cheap.
 *
 * Why we never throw:
 *   - A DB outage that throws here would bubble as a 500 to the
 *     admin. The admin can't fix that, and we'd rather degrade to
 *     "you're redirected to /dashboard" than to a stack trace. The
 *     try/catch swallows the error after logging it — the layout's
 *     `null` branch handles the rest.
 *
 * Wrapped in `react.cache(...)` so a single render that calls this
 * from both the (admin) layout AND the page deduplicates to ONE
 * Postgres round-trip per request. Same pattern `getDashboardUser`
 * uses in `lib/queries/sessions.ts`.
 */
export const getAdminUser = cache(async (): Promise<AdminUser | null> => {
  let session;
  try {
    session = await auth();
  } catch (err) {
    console.error("[admin/auth] auth() failed:", err);
    return null;
  }

  const userId = session?.user?.id;
  if (!userId) return null;

  try {
    const [row] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        isAdmin: schema.users.isAdmin,
      })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.id, userId),
          eq(schema.users.isAdmin, true),
          isNull(schema.users.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
    };
  } catch (err) {
    console.error("[admin/auth] DB lookup failed:", err);
    return null;
  }
});

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
}
