CREATE TABLE "story_rebuilds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_session_id" uuid,
	"source_improvement_index" integer,
	"question_text" text NOT NULL,
	"question_theme" text,
	"headline" text,
	"situation" text,
	"task" text,
	"action" text,
	"result" text,
	"what_i_would_change" text,
	"ai_critique_json" jsonb,
	"critique_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"promoted_to_story_id" uuid,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_rebuilds_status_valid" CHECK ("story_rebuilds"."status" IN ('in_progress', 'critiqued', 'saved_to_bank', 'discarded')),
	CONSTRAINT "story_rebuilds_question_theme_valid" CHECK ("story_rebuilds"."question_theme" IS NULL OR "story_rebuilds"."question_theme" IN (
        'leadership_conflict', 'biggest_failure', 'technical_disagreement',
        'ambiguous_problem', 'mentoring', 'cross_team_collaboration',
        'deadline_pressure', 'difficult_colleague', 'outside_comfort_zone',
        'recovering_from_mistake', 'other'
      ))
);
--> statement-breakpoint
ALTER TABLE "story_rebuilds" ADD CONSTRAINT "story_rebuilds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_rebuilds" ADD CONSTRAINT "story_rebuilds_source_session_id_interview_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_rebuilds" ADD CONSTRAINT "story_rebuilds_promoted_to_story_id_stories_id_fk" FOREIGN KEY ("promoted_to_story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "story_rebuilds_user_updated_idx" ON "story_rebuilds" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "story_rebuilds_session_idx" ON "story_rebuilds" USING btree ("source_session_id");--> statement-breakpoint
CREATE INDEX "story_rebuilds_user_status_idx" ON "story_rebuilds" USING btree ("user_id","status") WHERE "story_rebuilds"."status" <> 'discarded';--> statement-breakpoint
CREATE INDEX "story_rebuilds_discarded_idx" ON "story_rebuilds" USING btree ("updated_at") WHERE "story_rebuilds"."status" = 'discarded';