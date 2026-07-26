import "server-only";

import { eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

import { generateReferralCode } from "./code";

/**
 * Persistence helpers for the referral code on `users`.
 *
 * Generation is decoupled from the user-create transaction so we
 * can also lazily backfill rows that pre-date the
 * `0017_referrals.sql` migration — the Account page reads the
 * referral code on render and any null comes back populated through
 * `ensureReferralCodeForUser`.
 */

const PG_UNIQUE_VIOLATION = "23505";
const MAX_GENERATION_ATTEMPTS = 5;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Try-and-retry insertion of a fresh referral code on a Drizzle
 * transaction object. Used inside the credentials signup tx so the
 * user row, the signup-bonus ledger row, AND the referral code all
 * land atomically.
 *
 * Loops up to `MAX_GENERATION_ATTEMPTS` times — at 40 bits of
 * entropy a collision after retry-1 is astronomically unlikely, so
 * a 5th retry strongly suggests something else (e.g. the unique
 * index dropped) and we surface as an error rather than spin.
 *
 * First-writer-wins: the conditional UPDATE only sets the column
 * when it's still NULL. If the same user row already has a code
 * (e.g. an OAuth `events.createUser` retry, or two parallel
 * backfill paths), we re-read and return the EXISTING code instead
 * of overwriting it. This protects already-shared codes from being
 * silently rotated under a user.
 */
export async function setReferralCodeOnTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const code = generateReferralCode();
    try {
      const result = await tx
        .update(schema.users)
        .set({ referralCode: code })
        .where(
          sql`${schema.users.id} = ${userId} AND ${schema.users.referralCode} IS NULL`,
        )
        .returning({ referralCode: schema.users.referralCode });
      if (result.length > 0 && result[0]?.referralCode) {
        return result[0].referralCode;
      }
      // Either the user already has a code, or the row doesn't
      // exist. Re-read to disambiguate.
      const [recheck] = await tx
        .select({ referralCode: schema.users.referralCode })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      if (recheck?.referralCode) return recheck.referralCode;
      throw new Error(
        `setReferralCodeOnTx: user ${userId} not found`,
      );
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_GENERATION_ATTEMPTS - 1) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `setReferralCodeOnTx: exhausted ${MAX_GENERATION_ATTEMPTS} attempts for user ${userId}`,
  );
}

/**
 * Standalone (out-of-tx) helper: ensure the user row has a
 * referral code, generating one if not. Idempotent — safe to call
 * on every Account page load. Uses `WHERE referral_code IS NULL`
 * in the UPDATE so a concurrent backfill on the same user can
 * never overwrite an existing code.
 *
 * Returns the code in use after the call (existing or newly
 * minted). Throws after `MAX_GENERATION_ATTEMPTS` collisions so
 * the caller can fall back to "Invite friends — link unavailable"
 * rather than spin forever.
 */
export async function ensureReferralCodeForUser(
  userId: string,
): Promise<string> {
  const [existing] = await db
    .select({ referralCode: schema.users.referralCode })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (existing?.referralCode) return existing.referralCode;

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const code = generateReferralCode();
    try {
      // Conditional UPDATE: only set if still NULL. If a concurrent
      // call backfilled the row we read above, the WHERE clause
      // below matches zero rows, we re-read on the next loop, and
      // return the code that won the race.
      const result = await db
        .update(schema.users)
        .set({ referralCode: code })
        .where(
          sql`${schema.users.id} = ${userId} AND ${schema.users.referralCode} IS NULL`,
        )
        .returning({ referralCode: schema.users.referralCode });

      if (result.length > 0 && result[0]?.referralCode) {
        return result[0].referralCode;
      }

      // Either zero rows matched (someone else won the race) OR the
      // user row doesn't exist. Re-read to disambiguate.
      const [recheck] = await db
        .select({ referralCode: schema.users.referralCode })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      if (recheck?.referralCode) return recheck.referralCode;

      // No code AND the conditional UPDATE didn't take — the user
      // row is gone (hard-deleted between the initial select and
      // now). Surface as an error to the caller.
      throw new Error(
        `ensureReferralCodeForUser: user ${userId} not found`,
      );
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_GENERATION_ATTEMPTS - 1) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `ensureReferralCodeForUser: exhausted ${MAX_GENERATION_ATTEMPTS} attempts for user ${userId}`,
  );
}
