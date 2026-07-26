-- Referral credits feature.
--
-- Every user gets an auto-generated short referral code at signup
-- (Crockford base32, 8 chars, ~1.1T values). New signups can attribute
-- themselves to a referrer via `?ref=CODE` on the signup page. The
-- referee receives the existing `signup_bonus` (no change). The
-- referrer is granted +1 credit atomically inside the
-- `persistReportAndComplete` transaction the FIRST time the referee
-- completes an analysis (i.e. the first row in `reports` whose
-- `interview_sessions.user_id` is the referee).
--
-- Schema additions:
--
--   1. New `credit_transaction_reason` enum value `referral_bonus`,
--      so the +1 grant lands as its own audit-friendly row in the
--      `credit_transactions` ledger.
--
--   2. `credit_transactions.related_referee_user_id` — when a row's
--      reason is `referral_bonus`, this points at the referee that
--      triggered the payout, so the credits-history page can show
--      "Referral from <name>". Nullable + ON DELETE SET NULL so the
--      ledger row survives a referee hard-delete with its financial
--      truth intact (just loses the attribution link).
--
--   3. `users.referral_code` — short unique code minted at user
--      creation. UNIQUE so the lookup `WHERE referral_code = ?` is
--      fast and we can detect collisions on insert.
--
--   4. `users.referred_by_user_id` — set once at signup if the user
--      arrived via a valid `?ref=` link. ON DELETE SET NULL so a
--      hard-deleted referrer doesn't cascade into the referee row.
--
--   5. `users.referrer_credit_granted_at` — null while the referrer
--      hasn't been credited yet, set when the referee completes their
--      first analysis. Idempotency guard: the award path only
--      proceeds when this column IS NULL, then sets it inside the
--      same transaction.
--
--   6. CHECK constraint preventing self-referral at the DB level
--      (defense in depth — the application code also refuses).
--
-- ALTER TYPE ADD VALUE must be in its own statement, separate from
-- any transaction that USES the new value, hence the dedicated
-- breakpoint. The remaining DDL can run in a single transaction.

ALTER TYPE "public"."credit_transaction_reason" ADD VALUE IF NOT EXISTS 'referral_bonus';--> statement-breakpoint

ALTER TABLE "credit_transactions" ADD COLUMN "related_referee_user_id" uuid;--> statement-breakpoint

ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_related_referee_user_id_users_id_fk" FOREIGN KEY ("related_referee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "referral_code" text;--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "referred_by_user_id" uuid;--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "referrer_credit_granted_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_user_id_users_id_fk" FOREIGN KEY ("referred_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "users_referral_code_key" ON "users" USING btree ("referral_code");--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_not_self" CHECK ("users"."referred_by_user_id" IS NULL OR "users"."referred_by_user_id" <> "users"."id");
