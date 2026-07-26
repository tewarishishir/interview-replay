import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * Aggregate stats for the Account-page referral section + the
 * `/api/referrals/me` endpoint.
 *
 * Two cheap counts:
 *
 *   - `refereesCount`: how many ACTIVE users have
 *     `referred_by_user_id = userId`. Counts the funnel top —
 *     includes referees who haven't yet completed their first
 *     analysis (and so haven't triggered a payout), but EXCLUDES
 *     soft-deleted referees so the "Friends joined" tile doesn't
 *     count people who left.
 *
 *   - `creditsEarned`: SUM(delta) over `credit_transactions` where
 *     `userId = userId AND reason = 'referral_bonus'`. This is the
 *     authoritative dollar (well, credit) figure — it counts only
 *     payouts the referrer actually received. Bonuses earned from
 *     referees who later soft-deleted still count: the credit was
 *     already paid out and is in the referrer's balance.
 *
 * Both queries hit composite indexes that already exist
 * (`credit_transactions_user_created_idx` covers the credits sum,
 * and `users.referredByUserId` will get an automatic plan via the
 * FK lookup).
 */
export interface ReferralStats {
  refereesCount: number;
  creditsEarned: number;
}

export async function getReferralStats(
  userId: string,
): Promise<ReferralStats> {
  const [refereesRow, creditsRow] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.referredByUserId, userId),
          isNull(schema.users.deletedAt),
        ),
      )
      .then((rows) => rows[0]),
    db
      .select({
        n: sql<number>`COALESCE(sum(${schema.creditTransactions.delta}), 0)::int`,
      })
      .from(schema.creditTransactions)
      .where(
        and(
          eq(schema.creditTransactions.userId, userId),
          eq(schema.creditTransactions.reason, "referral_bonus"),
        ),
      )
      .then((rows) => rows[0]),
  ]);

  return {
    refereesCount: refereesRow?.n ?? 0,
    creditsEarned: creditsRow?.n ?? 0,
  };
}

/**
 * Convenience: the user-facing share link. Centralized here so the
 * Account page, Dashboard nudge, and `/api/referrals/me` all
 * compose the same URL shape (`/signup?ref=CODE`) against the
 * configured site origin.
 *
 * Falls back to a relative path when no origin is provided so the
 * link still works inside the same browser session even if the
 * caller forgot to pass the request's origin.
 */
export function buildReferralLink(args: {
  code: string;
  origin?: string | null;
}): string {
  const path = `/signup?ref=${encodeURIComponent(args.code)}`;
  if (!args.origin) return path;
  try {
    const url = new URL(path, args.origin);
    return url.toString();
  } catch {
    return path;
  }
}
