/**
 * The headline contract under test: when the referee's FIRST
 * credit-pack purchase reaches `status='succeeded'`, the referrer's
 * credit balance goes up by exactly 1 and the ledger gets a
 * `referral_bonus` row pointing back at the referee. Subsequent
 * purchases (referee's 2nd, 3rd, ...) MUST NOT pay out a second
 * time. Free-credit-only users — i.e. signups who never buy
 * anything — never pay out a referral bonus.
 *
 * Drives `awardReferrerOnFirstPurchase` directly. Production
 * invokes it from the Stripe `checkout.session.completed` webhook
 * handler after `grantCreditsFromPurchase` flips a purchase row to
 * `succeeded`; the test simulates that by inserting purchase rows
 * directly so we exercise the helper without needing a real Stripe
 * round-trip.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { awardReferrerOnFirstPurchase } from "@/lib/referrals";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

const seedReferrer = async () => {
  const result = await createCredentialsUser({
    email: "ref@example.com",
    password: "password123",
    name: "Referrer",
  });
  if (!result.ok) throw new Error(`seedReferrer: ${result.error}`);
  const [row] = await db
    .select({
      id: schema.users.id,
      referralCode: schema.users.referralCode,
      creditBalance: schema.users.creditBalance,
    })
    .from(schema.users)
    .where(eq(schema.users.id, result.user.id))
    .limit(1);
  if (!row?.referralCode) throw new Error("seedReferrer: no code");
  return {
    id: row.id,
    code: row.referralCode,
    initialBalance: row.creditBalance,
  };
};

const seedReferee = async (referralCode?: string | null) => {
  const result = await createCredentialsUser({
    email: "alice@example.com",
    password: "password123",
    name: "Alice",
    referralCode: referralCode ?? null,
  });
  if (!result.ok) throw new Error(`seedReferee: ${result.error}`);
  return result.user;
};

/**
 * Insert a `credit_purchases` row directly in the given status.
 * Mirrors what `grantCreditsFromPurchase` would produce for a real
 * webhook, minus the side-effects on `users.credit_balance` and
 * the `credit_transactions` ledger — the test only needs the
 * purchase row itself to drive `awardReferrerOnFirstPurchase`'s
 * count query.
 *
 * `paymentIntentSuffix` keeps the UNIQUE index on
 * `stripe_payment_intent_id` happy when a single test inserts
 * multiple purchases.
 */
const insertPurchase = async (args: {
  userId: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  paymentIntentSuffix: string;
}) => {
  const [row] = await db
    .insert(schema.creditPurchases)
    .values({
      userId: args.userId,
      packType: "starter",
      creditsPurchased: 4,
      amountPaidPaise: 999,
      txnId: `txn_test_${args.paymentIntentSuffix}`,
      status: args.status,
    })
    .returning({ id: schema.creditPurchases.id });
  if (!row) throw new Error("insertPurchase: no row");
  return row;
};

describe("awardReferrerOnFirstPurchase", () => {
  it("grants the referrer +1 credit on the referee's first succeeded purchase", async () => {
    const referrer = await seedReferrer();
    const referee = await seedReferee(referrer.code);
    await insertPurchase({
      userId: referee.id,
      status: "succeeded",
      paymentIntentSuffix: "1",
    });

    const result = await awardReferrerOnFirstPurchase(referee.id);
    expect(result.granted).toBe(true);

    const [referrerRow] = await db
      .select({ creditBalance: schema.users.creditBalance })
      .from(schema.users)
      .where(eq(schema.users.id, referrer.id))
      .limit(1);
    expect(referrerRow?.creditBalance).toBe(referrer.initialBalance + 2);

    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(
        and(
          eq(schema.creditTransactions.userId, referrer.id),
          eq(schema.creditTransactions.reason, "referral_bonus"),
        ),
      );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.delta).toBe(2);
    expect(ledger[0]?.balanceAfter).toBe(referrer.initialBalance + 2);
    expect(ledger[0]?.relatedRefereeUserId).toBe(referee.id);

    // Idempotency stamp on the referee.
    const [refereeRow] = await db
      .select({
        referrerCreditGrantedAt: schema.users.referrerCreditGrantedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, referee.id))
      .limit(1);
    expect(refereeRow?.referrerCreditGrantedAt).not.toBeNull();
  });

  it("does NOT pay out a second time on the referee's second succeeded purchase", async () => {
    const referrer = await seedReferrer();
    const referee = await seedReferee(referrer.code);

    // First purchase — pays the bonus.
    await insertPurchase({
      userId: referee.id,
      status: "succeeded",
      paymentIntentSuffix: "1",
    });
    await awardReferrerOnFirstPurchase(referee.id);

    // Second purchase — re-invoke (mirrors a second webhook firing).
    await insertPurchase({
      userId: referee.id,
      status: "succeeded",
      paymentIntentSuffix: "2",
    });
    const second = await awardReferrerOnFirstPurchase(referee.id);
    expect(second.granted).toBe(false);
    expect(second.reason).toBe("already_granted");

    const [referrerRow] = await db
      .select({ creditBalance: schema.users.creditBalance })
      .from(schema.users)
      .where(eq(schema.users.id, referrer.id))
      .limit(1);
    // Initial + 2 only — never twice.
    expect(referrerRow?.creditBalance).toBe(referrer.initialBalance + 2);

    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(
        and(
          eq(schema.creditTransactions.userId, referrer.id),
          eq(schema.creditTransactions.reason, "referral_bonus"),
        ),
      );
    expect(ledger).toHaveLength(1);
  });

  it("does NOT grant when the referee has only pending / failed purchases (free-credit-only signups)", async () => {
    // The whole point of moving from analysis-trigger to
    // purchase-trigger: a user who signed up via referral, used
    // their 10 free signup credits, and never bought a pack must
    // NOT pay a bonus. Simulate that with a `pending` purchase
    // row (a checkout the user started but didn't complete) and a
    // `failed` row (card declined).
    const referrer = await seedReferrer();
    const referee = await seedReferee(referrer.code);
    await insertPurchase({
      userId: referee.id,
      status: "pending",
      paymentIntentSuffix: "1",
    });
    await insertPurchase({
      userId: referee.id,
      status: "failed",
      paymentIntentSuffix: "2",
    });

    const result = await awardReferrerOnFirstPurchase(referee.id);
    expect(result.granted).toBe(false);
    expect(result.reason).toBe("not_first_purchase");

    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "referral_bonus"));
    expect(ledger).toHaveLength(0);

    const [referrerRow] = await db
      .select({ creditBalance: schema.users.creditBalance })
      .from(schema.users)
      .where(eq(schema.users.id, referrer.id))
      .limit(1);
    expect(referrerRow?.creditBalance).toBe(referrer.initialBalance);
  });

  it("does NOT grant when the referee has no referrer (organic signup)", async () => {
    const referee = await seedReferee(null);
    await insertPurchase({
      userId: referee.id,
      status: "succeeded",
      paymentIntentSuffix: "1",
    });

    const result = await awardReferrerOnFirstPurchase(referee.id);
    expect(result.granted).toBe(false);
    expect(result.reason).toBe("no_referrer");

    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "referral_bonus"));
    expect(ledger).toHaveLength(0);
  });

  it("does NOT grant when the referrer is soft-deleted before payout", async () => {
    const referrer = await seedReferrer();
    const referee = await seedReferee(referrer.code);
    await insertPurchase({
      userId: referee.id,
      status: "succeeded",
      paymentIntentSuffix: "1",
    });

    // Soft-delete the referrer — no bonus to a dying account.
    await db
      .update(schema.users)
      .set({ deletedAt: new Date() })
      .where(eq(schema.users.id, referrer.id));

    const result = await awardReferrerOnFirstPurchase(referee.id);
    expect(result.granted).toBe(false);
    expect(result.reason).toBe("referrer_unavailable");

    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(
        and(
          eq(schema.creditTransactions.userId, referrer.id),
          eq(schema.creditTransactions.reason, "referral_bonus"),
        ),
      );
    expect(ledger).toHaveLength(0);

    // Stamp stays NULL so the bonus can still pay out if the
    // referrer is restored before the referee's next purchase.
    const [refereeRow] = await db
      .select({
        referrerCreditGrantedAt: schema.users.referrerCreditGrantedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, referee.id))
      .limit(1);
    expect(refereeRow?.referrerCreditGrantedAt).toBeNull();
  });

  it("does NOT grant when the referee is soft-deleted", async () => {
    const referrer = await seedReferrer();
    const referee = await seedReferee(referrer.code);
    await insertPurchase({
      userId: referee.id,
      status: "succeeded",
      paymentIntentSuffix: "1",
    });

    await db
      .update(schema.users)
      .set({ deletedAt: new Date() })
      .where(eq(schema.users.id, referee.id));

    const result = await awardReferrerOnFirstPurchase(referee.id);
    expect(result.granted).toBe(false);
    expect(result.reason).toBe("referee_deleted");

    const [referrerRow] = await db
      .select({ creditBalance: schema.users.creditBalance })
      .from(schema.users)
      .where(eq(schema.users.id, referrer.id))
      .limit(1);
    expect(referrerRow?.creditBalance).toBe(referrer.initialBalance);
  });

  it("does NOT grant when only a refunded purchase exists (refund landed before bonus)", async () => {
    // Edge case: webhook delivery order is grant → refund without
    // the bonus ever firing in between. The referee has zero
    // succeeded purchases at the time we're invoked, so we don't
    // pay out. The stamp stays NULL so a FUTURE successful
    // purchase can still trigger the bonus.
    const referrer = await seedReferrer();
    const referee = await seedReferee(referrer.code);
    await insertPurchase({
      userId: referee.id,
      status: "refunded",
      paymentIntentSuffix: "1",
    });

    const result = await awardReferrerOnFirstPurchase(referee.id);
    expect(result.granted).toBe(false);
    expect(result.reason).toBe("not_first_purchase");

    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "referral_bonus"));
    expect(ledger).toHaveLength(0);
  });

  it("is idempotent across concurrent invocations", async () => {
    // Simulates a Stripe webhook retry landing in parallel with
    // the original delivery. `awardReferrerOnFirstPurchase` is
    // called twice for the same referee; only the first should
    // pay out. The second SHOULD return granted=false with the
    // already_granted reason OR throw the idempotency guard error
    // (the loser of the FOR UPDATE race), and the referrer balance
    // MUST land at +1 either way.
    const referrer = await seedReferrer();
    const referee = await seedReferee(referrer.code);
    await insertPurchase({
      userId: referee.id,
      status: "succeeded",
      paymentIntentSuffix: "1",
    });

    const results = await Promise.allSettled([
      awardReferrerOnFirstPurchase(referee.id),
      awardReferrerOnFirstPurchase(referee.id),
    ]);

    // Exactly one fulfilled with granted:true. The other either
    // saw `already_granted` (peek caught the stamp after the
    // first tx committed) or threw the guard error (lost the
    // race AFTER passing the peek).
    const grantedCount = results.filter(
      (r): r is PromiseFulfilledResult<{ granted: boolean }> =>
        r.status === "fulfilled" && r.value.granted === true,
    ).length;
    expect(grantedCount).toBe(1);

    const [referrerRow] = await db
      .select({ creditBalance: schema.users.creditBalance })
      .from(schema.users)
      .where(eq(schema.users.id, referrer.id))
      .limit(1);
    expect(referrerRow?.creditBalance).toBe(referrer.initialBalance + 2);

    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(
        and(
          eq(schema.creditTransactions.userId, referrer.id),
          eq(schema.creditTransactions.reason, "referral_bonus"),
        ),
      );
    expect(ledger).toHaveLength(1);
  });
});
