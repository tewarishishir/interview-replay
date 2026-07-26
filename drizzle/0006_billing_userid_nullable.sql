ALTER TABLE "credit_purchases" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_transactions" ALTER COLUMN "user_id" DROP NOT NULL;