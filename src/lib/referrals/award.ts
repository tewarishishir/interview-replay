import "server-only";

import { sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * Grant the referrer +2 credits when the referee completes their
 * FIRST successful credit-pack purchase (recharge). The trigger used
 * to be the first completed analysis, but that paid out bonuses for
 * users who only ever used the 10 free signup credits and never paid
 * us a cent — so the referee-must-pay rule was introduced. The bonus
 * was then raised from +1 to +2 credits to make the incentive more
 * compelling.
 *
 * Self-managed transaction. We deliberately do NOT accept a caller
 * `tx` parameter because the natural caller (the Stripe webhook
 * handler, after `grantCreditsFromPurchase` returns) already holds
 * an exclusive lock on the referee's user row inside that helper's
 * transaction. Re-locking the same row from a nested context AND a
 * second user row (the referrer) reintroduces the mutual-referral
 * deadlock that the id-sorted FOR UPDATE strategy was meant to
 * avoid. Running our own tx avoids the nesting entirely.
 *
 * Idempotency contract: safe to call after every Stripe webhook
 * delivery for `checkout.session.completed`. Short-circuits when
 *
 *   - the referee has no `referred_by_user_id`,
 *   - the referee has already had `referrer_credit_granted_at`
 *     stamped (the bonus was already paid out from a previous
 *     successful purchase, OR — for legacy accounts created before
 *     this change — from the now-retired first-analysis trigger), OR
 *   - this is not the referee's first SUCCEEDED purchase in
 *     `credit_purchases`.
 *
 * The `WHERE referrer_credit_granted_at IS NULL` guard on the final
 * UPDATE is the load-bearing single-fire guarantee — even with two
 * webhook deliveries racing (e.g. Stripe retry on top of a slow
 * first delivery), only the first one to commit can flip the
 * column from NULL → set.
 *
 * Lock ordering: when both the referee and referrer rows need
 * `FOR UPDATE`, we acquire them in DETERMINISTIC id-sorted order
 * via a single `WHERE id IN (...) ORDER BY id FOR UPDATE`. This
 * fixes the mutual-referral deadlock (A referred B AND B referred A,
 * both making their first purchase simultaneously): sorted lock
 * acquisition turns the deadlock into a normal serialization.
 *
 * Failures throw. The caller (Stripe webhook handler) returns 500
 * on throw, which makes Stripe retry the delivery. Idempotency
 * keeps the retry safe: a second invocation that the stamp has
 * already cleared takes the `already_granted` short-circuit.
 */
export async function awardReferrerOnFirstPurchase(
  refereeId: string,
): Promise<{ granted: boolean; reason?: string }> {
  return db.transaction(async (tx) => {
    // Step 1: peek at the referee's referral state WITHOUT a lock so
    // we know the referrer id (needed to compute the lock order)
    // before we acquire any FOR UPDATE locks. READ COMMITTED is
    // enough here — we re-verify every value after we hold the locks.
    const peek = await tx.execute<{
      referred_by_user_id: string | null;
      referrer_credit_granted_at: Date | null;
    }>(sql`
      SELECT referred_by_user_id, referrer_credit_granted_at
      FROM ${schema.users}
      WHERE id = ${refereeId}
    `);
    const peeked = peek.rows[0];
    if (!peeked) {
      return { granted: false, reason: "referee_not_found" };
    }
    if (!peeked.referred_by_user_id) {
      return { granted: false, reason: "no_referrer" };
    }
    if (peeked.referrer_credit_granted_at) {
      return { granted: false, reason: "already_granted" };
    }

    const referrerId = peeked.referred_by_user_id;

    // Step 2: lock BOTH user rows in deterministic (id-sorted) order.
    // PostgreSQL acquires row locks in the order rows are returned
    // by the SELECT, so an `ORDER BY id FOR UPDATE` is sufficient.
    // The DB-level CHECK `users_referred_by_not_self` guarantees
    // referrerId !== refereeId, so this is always exactly two rows.
    const lockedRows = await tx.execute<{
      id: string;
      credit_balance: number;
      deleted_at: Date | null;
      referred_by_user_id: string | null;
      referrer_credit_granted_at: Date | null;
    }>(sql`
      SELECT id, credit_balance, deleted_at, referred_by_user_id,
             referrer_credit_granted_at
      FROM ${schema.users}
      WHERE id IN (${refereeId}, ${referrerId})
      ORDER BY id
      FOR UPDATE
    `);

    const referee = lockedRows.rows.find((r) => r.id === refereeId);
    const referrer = lockedRows.rows.find((r) => r.id === referrerId);
    if (!referee || !referrer) {
      // One of the two rows vanished between the peek and the
      // FOR UPDATE acquisition (hard-delete cron racing with us).
      return { granted: false, reason: "row_disappeared" };
    }

    // Re-verify guards under the lock — between the unlocked peek
    // and now, another writer COULD have stamped the column.
    if (referee.referrer_credit_granted_at) {
      return { granted: false, reason: "already_granted" };
    }
    // Defense in depth: refuse the grant if the referee is
    // soft-deleted. A purchase row's user_id stays populated until
    // the hard-delete cron anonymizes it, so a soft-deleted user's
    // Stripe webhook could still land here.
    if (referee.deleted_at) {
      return { granted: false, reason: "referee_deleted" };
    }
    // Re-verify the referrer link hasn't been rewritten since the
    // peek. `setReferredByOnTx` is first-writer-wins (refuses to
    // overwrite a non-null value) so this should be unreachable —
    // but if a future admin tool ever bypassed it, we'd silently
    // grant to the WRONG referrer. Refuse instead.
    if (referee.referred_by_user_id !== referrerId) {
      return { granted: false, reason: "referrer_changed" };
    }
    // Skip if the referrer is soft-deleted — no financial benefits
    // to accounts on the way out. (FK is ON DELETE SET NULL, so a
    // hard-deleted referrer would have already nulled the referee's
    // `referred_by_user_id` — caught at the peek above.)
    if (referrer.deleted_at) {
      return { granted: false, reason: "referrer_unavailable" };
    }

    // Count succeeded purchases for this referee under the lock so
    // the count is stable for the rest of the tx. Caller invokes
    // this AFTER `grantCreditsFromPurchase` has committed the
    // status flip to 'succeeded' — so a count of 1 means the
    // just-completed purchase is the referee's first. Anything > 1
    // means an earlier purchase already triggered the bonus path
    // (and either the bonus was paid then, in which case the stamp
    // check above would have short-circuited us; or this is a
    // re-fire of an old webhook on a long-paying customer, in which
    // case we deliberately don't pay a retroactive bonus).
    const purchaseCountResult = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM ${schema.creditPurchases}
      WHERE user_id = ${refereeId}
        AND status = 'succeeded'
    `);
    const purchaseCount = purchaseCountResult.rows[0]?.n ?? 0;
    if (purchaseCount !== 1) {
      return { granted: false, reason: "not_first_purchase" };
    }

    const newBalance = referrer.credit_balance + 2;

    await tx.execute(sql`
      UPDATE ${schema.users}
      SET credit_balance = ${newBalance}, updated_at = now()
      WHERE id = ${referrerId}
    `);

    await tx.insert(schema.creditTransactions).values({
      userId: referrerId,
      delta: 2,
      balanceAfter: newBalance,
      reason: "referral_bonus",
      relatedRefereeUserId: refereeId,
    });

    // Idempotency guard: stamp the referee's
    // `referrer_credit_granted_at` so any future call short-circuits
    // at the `already_granted` branch. The `IS NULL` predicate is
    // belt-and-braces given we're already holding the FOR UPDATE
    // lock — but it's the single source of truth across processes
    // that bypass this code path.
    const guardResult = await tx.execute<{ id: string }>(sql`
      UPDATE ${schema.users}
      SET referrer_credit_granted_at = now()
      WHERE id = ${refereeId} AND referrer_credit_granted_at IS NULL
      RETURNING id
    `);

    if (guardResult.rows.length === 0) {
      // Lost the race against another writer that just stamped the
      // column. Roll back the entire tx by throwing — we MUST NOT
      // commit a +1 credit to the referrer that another transaction
      // has already paid.
      throw new Error(
        `awardReferrerOnFirstPurchase: idempotency guard failed for referee ${refereeId}`,
      );
    }

    return { granted: true };
  });
}
