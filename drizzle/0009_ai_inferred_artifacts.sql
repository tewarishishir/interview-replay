CREATE TYPE "public"."ai_confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."artifact_source" AS ENUM('user_added', 'ai_inferred');--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "source" "artifact_source" DEFAULT 'user_added' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "ai_confidence" "ai_confidence";--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "linked_transcript_offset" integer;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "linked_transcript_length" integer;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "user_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "artifacts_session_source_idx" ON "artifacts" USING btree ("session_id","source");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_source_confidence_consistent" CHECK (("artifacts"."source" = 'ai_inferred' AND "artifacts"."ai_confidence" IS NOT NULL)
          OR ("artifacts"."source" = 'user_added' AND "artifacts"."ai_confidence" IS NULL));