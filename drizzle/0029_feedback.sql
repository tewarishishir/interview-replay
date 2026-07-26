-- Feedback capture: a small table backing the floating "Feedback"
-- widget in every authenticated layout and the `/admin/feedback`
-- moderation queue. Approved + consent_public rows are the seed for
-- the future home-page testimonials section (see
-- src/lib/feedback/queries.ts: `getApprovedTestimonials`).
--
-- Hand-added beyond the drizzle-generated diff:
--   1. CHECK constraint on `rating` (1 <= rating <= 5).
--   2. CHECK constraint on `status` ('pending' | 'approved' | 'rejected').
--   3. Partial index `feedback_approved_idx` scoped to the
--      testimonials query (status='approved' AND consent_public=true).
-- These match the conventions established by
-- `0010_session_outcomes.sql` (CHECK constraint on outcome_type) so
-- the schema-vs-migration boundary stays consistent.

CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"message" text NOT NULL,
	"consent_public" boolean DEFAULT false NOT NULL,
	"display_name" text,
	"display_role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"admin_notes" text,
	"page_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_rating_valid" CHECK ("feedback"."rating" >= 1 AND "feedback"."rating" <= 5);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_status_valid" CHECK ("feedback"."status" IN ('pending', 'approved', 'rejected'));
--> statement-breakpoint
CREATE INDEX "feedback_user_idx" ON "feedback" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "feedback_status_created_idx" ON "feedback" USING btree ("status","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "feedback_approved_idx" ON "feedback" USING btree ("approved_at" DESC NULLS LAST) WHERE "feedback"."status" = 'approved' AND "feedback"."consent_public" = true;
