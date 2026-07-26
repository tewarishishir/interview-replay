-- Second-stage curation gate for the home-page testimonials section.
-- See src/lib/db/schema/feedback.ts (`featured` + `featuredOrder` field
-- comments) and src/lib/feedback/queries.ts (`getApprovedTestimonials`)
-- for the read-side wiring. The admin moderation flow at
-- /admin/feedback approves rows generously (audit trail); featuring is
-- a narrower second toggle that lets the founder pick the 3-6
-- standouts that actually surface on the marketing home page.
--
-- Hand-added beyond the drizzle-generated diff:
--   1. CHECK constraint `feedback_featured_requires_consent_and_order`
--      enforcing the invariant "if featured=true, then consent_public
--      MUST be true AND featured_order MUST NOT be null". Documented
--      on the schema field comment. Defence in depth: the admin API
--      already rejects featuring an unconsented row, but a manual SQL
--      caller still can't smuggle one in.
--   2. Partial index `feedback_featured_idx` matching the
--      `getApprovedTestimonials` query shape exactly (status='approved'
--      AND consent_public=true AND featured=true), ordered by
--      featured_order ASC so the index satisfies the ORDER BY without
--      a sort step.
-- These match the conventions established by `0029_feedback.sql`
-- (CHECK + partial index hand-edits) so the schema-vs-migration
-- boundary stays consistent.
--
-- The status='approved' precondition for featuring is intentionally
-- NOT in the CHECK — it would force a cascading update whenever an
-- admin demotes an approved row back to pending/rejected. That cascade
-- lives in application code (admin API: un-featuring on status change)
-- where it can be reasoned about with the rest of the moderation flow.

ALTER TABLE "feedback" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "featured_order" integer;
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_featured_requires_consent_and_order" CHECK (("feedback"."featured" = false) OR ("feedback"."consent_public" = true AND "feedback"."featured_order" IS NOT NULL));
--> statement-breakpoint
CREATE INDEX "feedback_featured_idx" ON "feedback" USING btree ("featured_order" ASC NULLS LAST) WHERE "feedback"."status" = 'approved' AND "feedback"."consent_public" = true AND "feedback"."featured" = true;
