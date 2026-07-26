import {
  bigserial,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";

import { interviewSessions } from "./interviews";
import { users } from "./users";

/**
 * Postgres enum for credit-pack types. Carries the legacy `pro` /
 * `enterprise` (v0) and `heavy_prep` (v1-US) values forever (Postgres
 * won't drop enum values without a destructive type rewrite) plus
 * the India-launch active set `starter` / `standard` / `heavy`.
 *
 * Read paths must accept any value (rows from before the rename
 * may still be in the wild); write paths go through
 * `activeCreditPackTypeSchema` below to keep new rows on the active
 * set.
 */
export const creditPackType = pgEnum("credit_pack_type", [
  "starter",
  "standard",
  "pro",
  "enterprise",
  "heavy_prep",
  "heavy",
]);
export const creditPackTypeSchema = z.enum(creditPackType.enumValues);
export type CreditPackType = z.infer<typeof creditPackTypeSchema>;

/**
 * The three pack types the India-launch UI emits and the checkout API
 * accepts. Anything not in this set comes back as a 400 from the
 * checkout route — it's how we keep the legacy enum values from
 * leaking into newly-written purchases.
 */
export const ACTIVE_CREDIT_PACK_TYPES = [
  "starter",
  "standard",
  "heavy",
] as const;
export const activeCreditPackTypeSchema = z.enum(ACTIVE_CREDIT_PACK_TYPES);
export type ActiveCreditPackType = z.infer<typeof activeCreditPackTypeSchema>;

export const creditPurchaseStatus = pgEnum("credit_purchase_status", [
  "pending",
  "succeeded",
  "failed",
  "refunded",
]);
export const creditPurchaseStatusSchema = z.enum(creditPurchaseStatus.enumValues);
export type CreditPurchaseStatus = z.infer<typeof creditPurchaseStatusSchema>;

/**
 * One row per credit purchase. `onDelete: "restrict"` on the user FK
 * so we never silently lose financial history if a deletion request
 * races a not-yet-anonymized purchase row — soft-delete the user
 * instead and run a separate retention job that anonymizes purchases
 * past their legal hold window.
 *
 * `user_id` is nullable so the hard-delete account flow can anonymize
 * the row (NULL out attribution while keeping the financial record).
 * Application code MUST pass a `userId` on every insert; the DB-level
 * NULL is reserved for the post-deletion anonymization path only.
 *
 * NOTE: The `txn_*` columns store payment transaction references.
 * payment integration). They remain for migration compatibility
 * and can be repurposed as generic payment-provider fields in
 * self-hosted deployments.
 */
export const creditPurchases = pgTable(
  "credit_purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id").references(() => users.id, {
      onDelete: "restrict",
    }),

    packType: creditPackType("pack_type").notNull(),
    creditsPurchased: integer("credits_purchased").notNull(),

    /**
     * Gross amount paid by the customer, in paise (INR × 100).
     * GST is embedded — `amount_paid_paise = base + gst_amount_paise`.
     * The migration renamed this from `amount_paid_cents` and existing
     * USD-era rows have their cents value carried through unchanged
     * (legacy data, never displayed in the India-only UI).
     */
    amountPaidPaise: integer("amount_paid_paise").notNull(),

    /**
     * Embedded GST portion of `amount_paid_paise`, computed at order
     * creation time as `amount × 18 / 118` and persisted so the
     * invoice line items reconcile to the paise without recomputing
     * (and without floating-point surprises).
     */
    gstAmountPaise: integer("gst_amount_paise").notNull().default(0),

    /** Unique transaction id for this purchase. */
    txnId: text("txn_id").notNull().unique(),

    /** External payment provider's internal id. Nullable while pending. */
    txnRef: text("txn_ref"),

    /** Payment mode (e.g. UPI, CC, DC). NULL while pending. */
    paymentMode: text("payment_mode"),

    /**
     * Bank / instrument identifier (`bank_ref_num` for netbanking,
     * card brand for cards, etc.). Stored verbatim for debugging.
     */
    bankCode: text("bank_code"),

    /** Error message from payment provider on failure. NULL on success. */
    errorMessage: text("error_message"),

    status: creditPurchaseStatus("status").notNull().default("pending"),

    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    // Historical column. We previously wrote `now() + 12 months` here
    // intending a sweeper to expire stale credits, but the product
    // decision is that credits never expire. New rows leave this NULL;
    // legacy rows keep their populated timestamp as historical data.
    // Spend paths read `users.credit_balance` and ignore this column.
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("credit_purchases_user_created_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
    // Admin Ops dashboard: revenue today/yesterday/7-day + payment-
    // failure health check. We filter `status='succeeded'` /
    // `'failed'` and order by `created_at DESC`, so a composite
    // index on (status, created_at desc) supports both reads
    // without a sort.
    index("credit_purchases_status_created_idx").on(
      table.status,
      table.createdAt.desc(),
    ),
    // Admin user-detail page: "list this user's purchases by
    // status, lifetime spend". The existing
    // `(user_id, created_at)` index doesn't help when the WHERE
    // is `user_id = $1 AND status = 'succeeded'`; this one does.
    index("credit_purchases_user_status_idx").on(
      table.userId,
      table.status,
    ),
  ],
);

export const creditTransactionReason = pgEnum("credit_transaction_reason", [
  "signup_bonus",
  "purchase",
  "interview_charge",
  "interview_refund",
  "purchase_refund",
  "expiration",
  "admin_adjustment",
  // Per-rebuild-critique sub-credit charge (0.20 credits each, batched
  // into one whole-credit ledger row every 5 critiques). The accumulator
  // lives on `users.rebuild_critique_units`; when it rolls over,
  // `chargeRebuildCritique` writes one row with `reason =
  // 'rebuild_critique_charge'` and `delta = -1`. Critiques that don't
  // trigger rollover never touch this enum value.
  "rebuild_critique_charge",
  // +1 credit granted to a referrer when the referee they signed up
  // makes their FIRST SUCCEEDED credit-pack purchase. Written by
  // `awardReferrerOnFirstPurchase` in `src/lib/referrals/award.ts`,
  // invoked from the Stripe `checkout.session.completed` webhook
  // handler after `grantCreditsFromPurchase` commits. Idempotent
  // via `users.referrer_credit_granted_at`. The triggering referee
  // is recorded on `credit_transactions.related_referee_user_id`.
  "referral_bonus",
]);
export const creditTransactionReasonSchema = z.enum(
  creditTransactionReason.enumValues,
);
export type CreditTransactionReason = z.infer<
  typeof creditTransactionReasonSchema
>;

/**
 * APPEND-ONLY ledger. Never UPDATE, never DELETE — corrections are made
 * by writing a compensating transaction. `balance_after` is denormalized
 * so we can audit the running balance at any point without replaying the
 * whole stream.
 *
 * The schema can't, on its own, prevent updates/deletes — enforce via
 * code review, repository-pattern boundaries, and (later) a row-level
 * trigger if we promote this constraint to "load-bearing".
 *
 * `bigserial` because at scale this table grows monotonically faster
 * than UUIDs would page-cache nicely.
 */
export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),

    /**
     * Nullable to support the hard-delete account flow's
     * anonymization step. Application writes MUST set this — the
     * DB-level NULL is reserved for post-deletion attribution
     * scrubbing only.
     */
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "restrict",
    }),

    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    reason: creditTransactionReason("reason").notNull(),

    relatedSessionId: uuid("related_session_id").references(
      () => interviewSessions.id,
      // Ledger entries survive session hard-deletes; null out the link.
      { onDelete: "set null" },
    ),
    relatedPurchaseId: uuid("related_purchase_id").references(
      () => creditPurchases.id,
      { onDelete: "set null" },
    ),

    /**
     * Populated only on `reason = 'referral_bonus'` rows: the
     * referee whose first-analysis completion triggered the +1
     * payout to the referrer (`userId`). The credits-history page
     * left-joins this back to `users` so the row can render
     * "Referral from <referee name>".
     *
     * ON DELETE SET NULL so a referee hard-delete doesn't cascade
     * the grant row out of existence — the financial truth ("we
     * gave the referrer +1 credit on this date") survives even if
     * the attribution link doesn't.
     */
    relatedRefereeUserId: uuid("related_referee_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("credit_transactions_user_created_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
  ],
);

export type CreditPurchase = typeof creditPurchases.$inferSelect;
export type NewCreditPurchase = typeof creditPurchases.$inferInsert;
export type CreditTransaction = typeof creditTransactions.$inferSelect;
export type NewCreditTransaction = typeof creditTransactions.$inferInsert;
