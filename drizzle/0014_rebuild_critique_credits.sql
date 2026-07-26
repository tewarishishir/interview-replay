-- Practice Rebuild critique sub-credit charging.
--
-- Each rebuild critique costs 0.25 credits. The credit ledger
-- (`credit_transactions.delta`) and the running balance
-- (`users.credit_balance`) are integer columns and we don't want to
-- rescale the whole credit system for one feature. Instead, we
-- accumulate critiques in an integer counter (`rebuild_critique_units`)
-- and deduct one whole credit on every 4th critique.
--
-- This migration:
--   1. Adds the `rebuild_critique_charge` value to the
--      `credit_transaction_reason` enum so the rollover ledger row has
--      its own reason (vs. piggy-backing on `interview_charge`).
--   2. Adds `users.rebuild_critique_units` (integer, default 0,
--      bounded 0..3 by a CHECK).
--
-- ALTER TYPE ADD VALUE must be in its own statement (not bundled with
-- a transaction that also uses the new value), so it lives in its own
-- breakpointed statement here.

ALTER TYPE "public"."credit_transaction_reason" ADD VALUE IF NOT EXISTS 'rebuild_critique_charge';--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "rebuild_critique_units" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_rebuild_critique_units_range" CHECK ("users"."rebuild_critique_units" >= 0 AND "users"."rebuild_critique_units" < 4);
