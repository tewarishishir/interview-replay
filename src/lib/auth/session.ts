import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import type { Session } from "next-auth";

import { db, schema } from "@/lib/db";

import { auth } from "./index";

/**
 * Single source of truth for "is the caller a still-active user?".
 *
 * Background: with the JWT session strategy, an Auth.js session can
 * outlive the underlying user — once a row has `deleted_at` set, the
 * stateless cookie keeps validating until expiry. The `(app)` layout
 * closes that gap with a per-request DB lookup (see
 * `src/app/(app)/layout.tsx`), but server actions and API route
 * handlers do NOT render layouts, so they were silently bypassing
 * the check. A soft-deleted user could keep POSTing to
 * `/api/sessions` for the rest of their token's lifetime.
 *
 * Every write endpoint and server action that wants to require an
 * active user MUST go through this helper instead of calling `auth()`
 * directly. The function returns `null` for both "no session" and
 * "session valid but user is deleted" — callers should treat those
 * the same way (401 / redirect to signin).
 *
 * The DB hit is one indexed PK lookup per request — same cost as
 * the layout's existing `getDashboardUser` revocation check.
 */
export async function getActiveUserId(): Promise<string | null> {
  let session: Session | null = null;
  try {
    // `auth()` is overloaded for middleware vs RSC. Calling with no
    // args yields `Promise<Session | null>`; the cast pins the
    // overload TypeScript would otherwise resolve to `NextMiddleware`.
    session = (await auth()) as Session | null;
  } catch (err) {
    // `auth()` decoding can throw on a malformed cookie or when the
    // signing key has rotated. Treat any failure as "not signed in"
    // so the caller redirects/401s instead of bubbling a 500 with
    // the stack baked in.
    console.error("[getActiveUserId] auth() failed:", err);
    return null;
  }

  const id = session?.user?.id;
  if (!id) return null;

  // Match on `id AND deleted_at IS NULL`. We intentionally ignore
  // any caching here — the entire point of this lookup is to react
  // to a deletion that happened *after* the JWT was minted.
  //
  // DB outages: fail CLOSED. Returning null forces a 401 / signin
  // redirect, which is the correct behavior when we genuinely can't
  // verify the user is still active. The alternative (let the error
  // bubble) shows the user a generic 500 for what is, from their
  // perspective, "we don't know if you're allowed in" — better to
  // ask them to sign in again.
  try {
    const [row] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, id), isNull(schema.users.deletedAt)))
      .limit(1);

    return row?.id ?? null;
  } catch (err) {
    console.error("[getActiveUserId] DB lookup failed:", err);
    return null;
  }
}
