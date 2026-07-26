CREATE TABLE "session_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"outcome_type" text NOT NULL,
	"outcome_received_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_round_type" text,
	"feedback_received" text,
	"reflection_notes" text,
	"would_change" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_outcomes" ADD CONSTRAINT "session_outcomes_session_id_interview_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "session_outcomes_session_id_uniq" ON "session_outcomes" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "session_outcomes_recorded_idx" ON "session_outcomes" USING btree ("recorded_at" DESC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "session_outcomes" ADD CONSTRAINT "session_outcomes_outcome_type_valid" CHECK ("session_outcomes"."outcome_type" IN ('advanced_to_next_round', 'received_offer', 'rejected', 'withdrew', 'no_response', 'other'));
