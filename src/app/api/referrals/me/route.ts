import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { getActiveUserId } from "@/lib/auth/session";
import {
  buildReferralLink,
  ensureReferralCodeForUser,
  getReferralStats,
} from "@/lib/referrals";

/**
 * GET /api/referrals/me
 *
 * Returns the authenticated user's referral code, share link, and
 * payout summary. The Account-page section + Dashboard nudge fetch
 * this on mount so the displayed counts ("X friends joined • Y
 * credits earned") stay live without a full server-component
 * round-trip after a copy/share interaction.
 *
 * The endpoint also lazily backfills `users.referral_code` for
 * accounts that pre-date migration `0017_referrals.sql` — the very
 * first GET on those rows mints + returns a fresh code.
 *
 * Returns 401 for unauthenticated requests, never 404 (every
 * authenticated user has a code by the time this returns).
 *
 * Cache-Control: no-store. The payout count changes the moment a
 * referee completes their first analysis, and a stale tile would
 * be a confusing UX signal in the share modal.
 */

export async function GET(): Promise<Response> {
  const userId = await getActiveUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "You must be signed in." },
      { status: 401 },
    );
  }

  // Backfill / minting is idempotent + safe to call on every load.
  // We parallelize against `getReferralStats` so the endpoint
  // doesn't pay for two sequential round-trips.
  const [code, stats] = await Promise.all([
    ensureReferralCodeForUser(userId),
    getReferralStats(userId),
  ]);

  // Best-effort origin: prefer the request's own URL so dev /
  // production / preview deploys all produce the right share link
  // without an env round-trip.
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? null;
  const origin = host ? `${proto}://${host}` : null;
  const link = buildReferralLink({ code, origin });

  return NextResponse.json(
    {
      code,
      link,
      refereesCount: stats.refereesCount,
      creditsEarned: stats.creditsEarned,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
