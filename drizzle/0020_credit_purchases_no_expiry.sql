-- Credits no longer expire (product decision). Drop the partial index
-- the never-shipped expiry sweeper would have used and relax the
-- NOT NULL on `expires_at` so new rows can leave it unset. Existing
-- rows keep their populated `expires_at` value — it's now a harmless
-- historical timestamp.
DROP INDEX IF EXISTS "credit_purchases_active_expires_idx";--> statement-breakpoint
ALTER TABLE "credit_purchases" ALTER COLUMN "expires_at" DROP NOT NULL;
