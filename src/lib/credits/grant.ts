import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { gstFromGrossPaise } from "@/lib/billing/pricing";

/**
 * Credit grant and revocation helpers.
 *
 *   - `grantCreditsFromPurchase` grants credits for a purchase row.
 *     Idempotent: a purchase row whose status is already `succeeded`
 *     short-circuits with `{ applied: false }`.
 *
 *   - `revokeCreditsFromRefund` revokes credits for a refunded
 *     purchase, clamping the balance at zero. Also idempotent.
 *
 * Both helpers run as one DB transaction so the status flip and the
 * ledger insert commit atomically.
 */

export interface GrantCreditsResult {
  applied: boolean;
  newBalance: number;
  userId: string | null;
  skippedReason?:
    | "already_succeeded"
    | "already_refunded"
    | "metadata_mismatch"
    | "user_anonymized";
}

export interface GrantExpectations {
  expectedPackType: "starter" | "standard" | "heavy";
  expectedCredits: number;
}

export async function grantCreditsFromPurchase(args: {
  txnId: string;
  txnRef?: string;
  paymentMode?: string;
  bankCode?: string;
  expectations?: GrantExpectations;
}): Promise<GrantCreditsResult | null> {
  return db.transaction(async (tx) => {
    const lockedPurchase = await tx.execute<{
      id: string;
      user_id: string | null;
      pack_type: string;
      credits_purchased: number;
      status: string;
    }>(sql`
      SELECT id, user_id, pack_type, credits_purchased, status
      FROM ${schema.creditPurchases}
      WHERE txn_id = ${args.txnId}
      FOR UPDATE
    `);

    const purchase = lockedPurchase.rows[0];
    if (!purchase) return null;

    if (purchase.user_id == null) {
      if (purchase.status === "pending") {
        await tx
          .update(schema.creditPurchases)
          .set({
            status: "succeeded",
            txnRef: args.txnRef ?? null,
            paymentMode: args.paymentMode ?? null,
            bankCode: args.bankCode ?? null,
          })
          .where(eq(schema.creditPurchases.id, purchase.id));
      }
      console.warn(
        `[grantCreditsFromPurchase] txnid ${args.txnId} ` +
          `landed on an anonymized purchase row (user hard-deleted). ` +
          `Marked succeeded; operator should reverse manually.`,
      );
      return {
        applied: false,
        newBalance: 0,
        userId: null,
        skippedReason: "user_anonymized",
      };
    }

    if (purchase.status === "succeeded") {
      const [user] = await tx
        .select({ creditBalance: schema.users.creditBalance })
        .from(schema.users)
        .where(eq(schema.users.id, purchase.user_id))
        .limit(1);
      return {
        applied: false,
        newBalance: user?.creditBalance ?? 0,
        userId: purchase.user_id,
        skippedReason: "already_succeeded",
      };
    }

    if (purchase.status === "refunded") {
      const [user] = await tx
        .select({ creditBalance: schema.users.creditBalance })
        .from(schema.users)
        .where(eq(schema.users.id, purchase.user_id))
        .limit(1);
      return {
        applied: false,
        newBalance: user?.creditBalance ?? 0,
        userId: purchase.user_id,
        skippedReason: "already_refunded",
      };
    }

    if (args.expectations) {
      const packMatches =
        purchase.pack_type === args.expectations.expectedPackType;
      const creditsMatch =
        purchase.credits_purchased === args.expectations.expectedCredits;
      if (!packMatches || !creditsMatch) {
        const [user] = await tx
          .select({ creditBalance: schema.users.creditBalance })
          .from(schema.users)
          .where(eq(schema.users.id, purchase.user_id))
          .limit(1);
        return {
          applied: false,
          newBalance: user?.creditBalance ?? 0,
          userId: purchase.user_id,
          skippedReason: "metadata_mismatch",
        };
      }
    }

    const lockedUser = await tx.execute<{ credit_balance: number }>(sql`
      SELECT credit_balance
      FROM ${schema.users}
      WHERE id = ${purchase.user_id} AND deleted_at IS NULL
      FOR UPDATE
    `);
    const userRow = lockedUser.rows[0];
    if (!userRow) {
      throw new Error(
        `grantCreditsFromPurchase: user ${purchase.user_id} not found or soft-deleted`,
      );
    }

    const newBalance = userRow.credit_balance + purchase.credits_purchased;

    await tx
      .update(schema.users)
      .set({ creditBalance: newBalance, updatedAt: new Date() })
      .where(eq(schema.users.id, purchase.user_id));

    await tx
      .update(schema.creditPurchases)
      .set({
        status: "succeeded",
        txnRef: args.txnRef ?? null,
        paymentMode: args.paymentMode ?? null,
        bankCode: args.bankCode ?? null,
      })
      .where(eq(schema.creditPurchases.id, purchase.id));

    await tx.insert(schema.creditTransactions).values({
      userId: purchase.user_id,
      delta: purchase.credits_purchased,
      balanceAfter: newBalance,
      reason: "purchase",
      relatedPurchaseId: purchase.id,
    });

    return { applied: true, newBalance, userId: purchase.user_id };
  });
}

export interface RevokeCreditsResult {
  applied: boolean;
  newBalance: number;
  skippedReason?: "already_refunded" | "not_succeeded" | "user_anonymized";
}

/**
 * Revoke credits granted by a previously-succeeded purchase.
 * Partial refunds intentionally do NOT revoke credits.
 */
export async function revokeCreditsFromRefund(args: {
  txnId: string;
}): Promise<RevokeCreditsResult | null> {
  return db.transaction(async (tx) => {
    const lockedPurchase = await tx.execute<{
      id: string;
      user_id: string | null;
      credits_purchased: number;
      status: string;
    }>(sql`
      SELECT id, user_id, credits_purchased, status
      FROM ${schema.creditPurchases}
      WHERE txn_id = ${args.txnId}
      FOR UPDATE
    `);

    const purchase = lockedPurchase.rows[0];
    if (!purchase) return null;

    if (purchase.user_id == null) {
      if (purchase.status !== "refunded") {
        await tx
          .update(schema.creditPurchases)
          .set({ status: "refunded", refundedAt: new Date() })
          .where(eq(schema.creditPurchases.id, purchase.id));
      }
      console.warn(
        `[revokeCreditsFromRefund] txnid ${args.txnId} ` +
          `landed on an anonymized purchase row (user hard-deleted). ` +
          `Marked refunded; no balance to revoke.`,
      );
      return {
        applied: false,
        newBalance: 0,
        skippedReason: "user_anonymized",
      };
    }

    if (purchase.status === "refunded") {
      const [user] = await tx
        .select({ creditBalance: schema.users.creditBalance })
        .from(schema.users)
        .where(eq(schema.users.id, purchase.user_id))
        .limit(1);
      return {
        applied: false,
        newBalance: user?.creditBalance ?? 0,
        skippedReason: "already_refunded",
      };
    }

    if (purchase.status !== "succeeded") {
      const [user] = await tx
        .select({ creditBalance: schema.users.creditBalance })
        .from(schema.users)
        .where(eq(schema.users.id, purchase.user_id))
        .limit(1);
      return {
        applied: false,
        newBalance: user?.creditBalance ?? 0,
        skippedReason: "not_succeeded",
      };
    }

    const lockedUser = await tx.execute<{ credit_balance: number }>(sql`
      SELECT credit_balance
      FROM ${schema.users}
      WHERE id = ${purchase.user_id} AND deleted_at IS NULL
      FOR UPDATE
    `);
    const userRow = lockedUser.rows[0];
    if (!userRow) {
      throw new Error(
        `revokeCreditsFromRefund: user ${purchase.user_id} not found or soft-deleted`,
      );
    }

    const newBalance = Math.max(
      0,
      userRow.credit_balance - purchase.credits_purchased,
    );
    const actualDelta = newBalance - userRow.credit_balance;

    await tx
      .update(schema.users)
      .set({ creditBalance: newBalance, updatedAt: new Date() })
      .where(eq(schema.users.id, purchase.user_id));

    await tx
      .update(schema.creditPurchases)
      .set({ status: "refunded", refundedAt: new Date() })
      .where(eq(schema.creditPurchases.id, purchase.id));

    await tx.insert(schema.creditTransactions).values({
      userId: purchase.user_id,
      delta: actualDelta,
      balanceAfter: newBalance,
      reason: "purchase_refund",
      relatedPurchaseId: purchase.id,
    });

    return { applied: true, newBalance };
  });
}

/**
 * Insert a pending purchase row. Stores the GST amount (embedded,
 * 18% of gross) for record keeping.
 */
export async function insertPendingPurchase(args: {
  userId: string;
  packType: "starter" | "standard" | "heavy";
  creditsPurchased: number;
  amountPaise: number;
  txnId: string;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(schema.creditPurchases)
    .values({
      userId: args.userId,
      packType: args.packType,
      creditsPurchased: args.creditsPurchased,
      amountPaidPaise: args.amountPaise,
      gstAmountPaise: gstFromGrossPaise(args.amountPaise),
      txnId: args.txnId,
      status: "pending",
    })
    .returning({ id: schema.creditPurchases.id });

  if (!row) {
    throw new Error("insertPendingPurchase: INSERT returned no row");
  }
  return row;
}

/**
 * Read-side: list a user's most recent purchases for the
 * `/credits/buy` purchase-history block.
 */
export async function listRecentPurchases(args: {
  userId: string;
  limit?: number;
}): Promise<
  Array<{
    id: string;
    packType: string;
    creditsPurchased: number;
    amountPaidPaise: number;
    gstAmountPaise: number;
    status: string;
    createdAt: Date;
  }>
> {
  const limit = Math.max(1, Math.min(20, args.limit ?? 5));
  const rows = await db
    .select({
      id: schema.creditPurchases.id,
      packType: schema.creditPurchases.packType,
      creditsPurchased: schema.creditPurchases.creditsPurchased,
      amountPaidPaise: schema.creditPurchases.amountPaidPaise,
      gstAmountPaise: schema.creditPurchases.gstAmountPaise,
      status: schema.creditPurchases.status,
      createdAt: schema.creditPurchases.createdAt,
    })
    .from(schema.creditPurchases)
    .where(eq(schema.creditPurchases.userId, args.userId))
    .orderBy(sql`${schema.creditPurchases.createdAt} DESC`)
    .limit(limit);
  return rows;
}

/**
 * Grant the one-time free-trial credits to a newly-created user.
 * Two-credit grant is the launch value (one 60-min interview or two
 * 30-min rounds).
 *
 * Email-reuse abuse check: looks up the audit log for prior accounts
 * that signed up with the same email. If found, grants 0 credits and
 * stamps `free_credit_used = true` so the dashboard nudge doesn't
 * pretend the user has a free trial. The audit log is the source of
 * truth because it survives soft-delete + re-signup with the same
 * email — relying on `users` alone would miss the abuse vector where
 * the user hard-deletes and re-signs up.
 *
 * Returns the credit count actually granted (0 or 2) so the caller
 * can include it in the welcome email / analytics event.
 *
 * Designed to be called from the post-signup handler; safe to call
 * multiple times for the same user (idempotent via the
 * `signup_bonus` ledger row — a second call sees the row and bails).
 */
export async function grantFreeTrialCredits(args: {
  userId: string;
  email: string;
}): Promise<{ creditsGranted: number; alreadyApplied: boolean }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: schema.creditTransactions.id })
      .from(schema.creditTransactions)
      .where(
        and(
          eq(schema.creditTransactions.userId, args.userId),
          eq(schema.creditTransactions.reason, "signup_bonus"),
        ),
      )
      .limit(1);
    if (existing) {
      const [user] = await tx
        .select({ creditBalance: schema.users.creditBalance })
        .from(schema.users)
        .where(eq(schema.users.id, args.userId))
        .limit(1);
      return {
        creditsGranted: user?.creditBalance ?? 0,
        alreadyApplied: true,
      };
    }

    const priorSignups = await tx.execute<{ user_id: string | null }>(sql`
      SELECT user_id
      FROM ${schema.auditLog}
      WHERE event_type = 'auth.signup'
        AND event_data ->> 'email' = ${args.email}
        AND (user_id IS DISTINCT FROM ${args.userId} OR user_id IS NULL)
      LIMIT 1
    `);

    if (priorSignups.rows.length > 0) {
      await tx
        .update(schema.users)
        .set({ creditBalance: 0, freeCreditUsed: true, updatedAt: new Date() })
        .where(
          and(
            eq(schema.users.id, args.userId),
            isNull(schema.users.deletedAt),
          ),
        );
      await tx.insert(schema.auditLog).values({
        userId: args.userId,
        eventType: "credits.free_trial_denied",
        eventData: { reason: "email_reuse" },
      });
      return { creditsGranted: 0, alreadyApplied: false };
    }

    const FREE_CREDITS = 2;
    await tx
      .update(schema.users)
      .set({ creditBalance: FREE_CREDITS, updatedAt: new Date() })
      .where(
        and(eq(schema.users.id, args.userId), isNull(schema.users.deletedAt)),
      );

    await tx.insert(schema.creditTransactions).values({
      userId: args.userId,
      delta: FREE_CREDITS,
      balanceAfter: FREE_CREDITS,
      reason: "signup_bonus",
    });

    return { creditsGranted: FREE_CREDITS, alreadyApplied: false };
  });
}
