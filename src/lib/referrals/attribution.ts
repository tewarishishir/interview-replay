import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

import { normalizeReferralCode } from "./code";

/**
 * Resolve a referral code to a referrer user, applying every
 * "is this attribution legal?" gate the signup paths share:
 *
 *   - Code shape (Crockford base32, exactly REFERRAL_CODE_LENGTH).
 *     Junk silently no-ops to `null`.
 *   - Referrer must exist AND not be soft-deleted (we don't credit
 *     accounts heading for hard-delete).
 *   - Self-referral is refused via `excludeUserId` (referee's own
 *     id) AND `excludeEmail` (referee's email — credentials path
 *     can call this BEFORE the user row exists, so the email is
 *     the only available identity).
 *
 * Returns the referrer's id on success, `null` otherwise. Callers
 * pass the result straight to `users.referredByUserId` — the DB
 * CHECK `users_referred_by_not_self` is the load-bearing backstop
 * but we should never reach it.
 */
export async function resolveReferrerByCode(args: {
  code: unknown;
  excludeUserId?: string | null;
  excludeEmail?: string | null;
}): Promise<{ id: string } | null> {
  const code = normalizeReferralCode(args.code);
  if (!code) return null;

  const [row] = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.referralCode, code),
        isNull(schema.users.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return null;
  if (args.excludeUserId && row.id === args.excludeUserId) return null;
  if (
    args.excludeEmail &&
    row.email.trim().toLowerCase() === args.excludeEmail.trim().toLowerCase()
  ) {
    return null;
  }
  return { id: row.id };
}

/**
 * Set `users.referred_by_user_id` on a Drizzle transaction object,
 * but ONLY if it's still null (defense against double-attribution
 * from a buggy retry path). Idempotent: calling twice with the
 * same referrer is a no-op the second time. Calling with a
 * different referrer is also a no-op — first writer wins.
 *
 * The conditional `IS NULL` filter means a referee that signed up
 * organically can't later be retroactively attributed by a code
 * that lands in a cookie. That's the right behavior — referrals
 * are a one-shot at signup time.
 */
export async function setReferredByOnTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  refereeId: string,
  referrerId: string,
): Promise<void> {
  await tx
    .update(schema.users)
    .set({ referredByUserId: referrerId })
    .where(
      sql`${schema.users.id} = ${refereeId} AND ${schema.users.referredByUserId} IS NULL`,
    );
}
