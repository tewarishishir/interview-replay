ALTER TYPE "public"."artifact_type" ADD VALUE 'question';--> statement-breakpoint
ALTER TYPE "public"."artifact_type" ADD VALUE 'design_text';--> statement-breakpoint
ALTER TYPE "public"."artifact_type" ADD VALUE 'design_image';--> statement-breakpoint
ALTER TYPE "public"."artifact_type" ADD VALUE 'other_note';--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "transcription_error" text;