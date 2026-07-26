import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db, schema } from "@/lib/db";

/**
 * GET /api/auth/verify-email?token=...&email=...
 *
 * Consumes a verification token minted by `sendVerificationEmail`.
 * On success: stamps `users.email_verified = now()` and deletes the
 * token row, then redirects back to the signin page with a
 * `?verified=1` flash. The user signs in normally afterwards — we
 * don't auto-sign-in here because that would require minting an
 * Auth.js session from a server route, which is harder than the UX
 * is worth.
 *
 * On failure: redirects back to signin with an `?error=...` param
 * the signin page understands. We deliberately do NOT distinguish
 * "token expired" from "token never existed" in the redirect target
 * — both leak whether a given email has a pending verification, and
 * the practical UX is the same ("ask for a fresh email").
 *
 * Idempotency: a second click on the same link after the user is
 * already verified is treated as success (we just redirect to
 * signin). The DB transaction's `WHERE email_verified IS NULL`
 * predicate makes the stamp safe under concurrent retries.
 *
 * Auth: no session required. The token IS the auth — possession of
 * a fresh, unexpired token authorizes the verify. Tokens are
 * single-use (deleted on success) and bounded to 1h by
 * `TOKEN_LIFETIME_MS` at mint time.
 */

const baseUrl = (origin: string): string => origin.replace(/\/+$/, "");

const redirectTo = (origin: string, path: string): Response =>
  NextResponse.redirect(`${baseUrl(origin)}${path}`);

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const email = url.searchParams.get("email");

  if (!token || !email) {
    return redirectTo(url.origin, "/signin?error=verification_invalid");
  }

  // The verification_tokens schema uses (identifier, token) as the
  // composite PK. Look up by both — if either differs we treat it
  // as invalid (we don't want a token leaked from logs to be usable
  // against a different email).
  const [row] = await db
    .select({
      identifier: schema.verificationTokens.identifier,
      token: schema.verificationTokens.token,
      expires: schema.verificationTokens.expires,
    })
    .from(schema.verificationTokens)
    .where(
      and(
        eq(schema.verificationTokens.identifier, email),
        eq(schema.verificationTokens.token, token),
      ),
    )
    .limit(1);

  if (!row) {
    return redirectTo(url.origin, "/signin?error=verification_invalid");
  }

  if (row.expires.getTime() < Date.now()) {
    // Clean up the expired token so it doesn't accumulate. Best
    // effort — if the delete fails we still redirect with an
    // expired error.
    await db
      .delete(schema.verificationTokens)
      .where(
        and(
          eq(schema.verificationTokens.identifier, email),
          eq(schema.verificationTokens.token, token),
        ),
      )
      .catch(() => {
        /* swallowed — token already gone or DB blip; the user
           still gets the friendly expired-redirect. */
      });
    return redirectTo(url.origin, "/signin?error=verification_expired");
  }

  // Stamp + delete in one transaction. The `isNull(emailVerified)`
  // predicate makes this idempotent — a second click after the
  // user is already verified hits the same code path and returns
  // success without flipping the timestamp again.
  await db.transaction(async (tx) => {
    await tx
      .update(schema.users)
      .set({ emailVerified: new Date() })
      .where(
        and(eq(schema.users.email, email), isNull(schema.users.emailVerified)),
      );

    await tx
      .delete(schema.verificationTokens)
      .where(
        and(
          eq(schema.verificationTokens.identifier, email),
          eq(schema.verificationTokens.token, token),
        ),
      );
  });

  return redirectTo(url.origin, "/signin?verified=1");
}
