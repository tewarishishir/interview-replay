-- Drop credit/referral tables
DROP TABLE IF EXISTS "credit_transactions";
DROP TABLE IF EXISTS "credit_purchases";

-- Drop credit/referral enums
DROP TYPE IF EXISTS "credit_transaction_reason";
DROP TYPE IF EXISTS "credit_purchase_status";
DROP TYPE IF EXISTS "credit_pack_type";

-- Remove credit/referral columns from users
ALTER TABLE "users" DROP COLUMN IF EXISTS "credit_balance";
ALTER TABLE "users" DROP COLUMN IF EXISTS "rebuild_critique_units";
ALTER TABLE "users" DROP COLUMN IF EXISTS "free_credit_used";
ALTER TABLE "users" DROP COLUMN IF EXISTS "referral_code";
ALTER TABLE "users" DROP COLUMN IF EXISTS "referred_by_user_id";
ALTER TABLE "users" DROP COLUMN IF EXISTS "referrer_credit_granted_at";

-- Remove credits_charged from interview_sessions
ALTER TABLE "interview_sessions" DROP COLUMN IF EXISTS "credits_charged";

-- Drop CHECK constraints that reference removed columns
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_credit_balance_nonneg";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_rebuild_critique_units_range";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_referred_by_not_self";

-- Drop indexes on removed columns
DROP INDEX IF EXISTS "users_referral_code_key";
