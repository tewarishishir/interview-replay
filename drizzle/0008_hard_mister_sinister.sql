CREATE TYPE "public"."resume_parse_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."story_theme" AS ENUM('leadership_conflict', 'biggest_failure', 'technical_disagreement', 'ambiguous_problem', 'mentoring', 'cross_team_collaboration', 'deadline_pressure', 'difficult_colleague', 'outside_comfort_zone', 'recovering_from_mistake', 'other');--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"company_context" text,
	"time_period" text,
	"scale_description" text,
	"team_size" text,
	"my_role" text,
	"key_decisions" text,
	"outcomes_with_metrics" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resume_parse_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "resume_parse_status" DEFAULT 'pending' NOT NULL,
	"s3_key" text NOT NULL,
	"draft_json" jsonb,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"theme" "story_theme" NOT NULL,
	"title" text NOT NULL,
	"situation" text,
	"task" text,
	"action" text,
	"result" text,
	"what_i_learned" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"years_of_experience" integer,
	"current_role" text,
	"companies" jsonb,
	"technologies" jsonb,
	"education" jsonb,
	"resume_saved_at" timestamp with time zone,
	"levels" jsonb,
	"target_companies" jsonb,
	"career_narrative" text,
	"exclude_resume" boolean DEFAULT false NOT NULL,
	"exclude_projects" boolean DEFAULT false NOT NULL,
	"exclude_stories" boolean DEFAULT false NOT NULL,
	"exclude_target" boolean DEFAULT false NOT NULL,
	"resume_updated_at" timestamp with time zone,
	"target_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_yoe_range" CHECK ("user_profiles"."years_of_experience" IS NULL OR ("user_profiles"."years_of_experience" >= 0 AND "user_profiles"."years_of_experience" <= 60)),
	CONSTRAINT "user_profiles_companies_max" CHECK ("user_profiles"."companies" IS NULL OR jsonb_array_length("user_profiles"."companies") <= 20),
	CONSTRAINT "user_profiles_technologies_max" CHECK ("user_profiles"."technologies" IS NULL OR jsonb_array_length("user_profiles"."technologies") <= 50),
	CONSTRAINT "user_profiles_education_max" CHECK ("user_profiles"."education" IS NULL OR jsonb_array_length("user_profiles"."education") <= 10),
	CONSTRAINT "user_profiles_levels_max" CHECK ("user_profiles"."levels" IS NULL OR jsonb_array_length("user_profiles"."levels") <= 6),
	CONSTRAINT "user_profiles_target_companies_max" CHECK ("user_profiles"."target_companies" IS NULL OR jsonb_array_length("user_profiles"."target_companies") <= 50)
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_parse_jobs" ADD CONSTRAINT "resume_parse_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_user_order_idx" ON "projects" USING btree ("user_id","display_order");--> statement-breakpoint
CREATE INDEX "projects_user_updated_idx" ON "projects" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "resume_parse_jobs_id_user_uniq" ON "resume_parse_jobs" USING btree ("id","user_id");--> statement-breakpoint
CREATE INDEX "resume_parse_jobs_user_created_idx" ON "resume_parse_jobs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "resume_parse_jobs_status_idx" ON "resume_parse_jobs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "stories_user_theme_idx" ON "stories" USING btree ("user_id","theme","created_at");--> statement-breakpoint
CREATE INDEX "stories_user_updated_idx" ON "stories" USING btree ("user_id","updated_at" DESC NULLS LAST);