-- Admin dashboard (Phase 1 — Daily Ops + scaffolding for Phases 2 & 3).
--
-- Changes:
--   1. `users.is_admin` boolean column (default false). Gates the entire
--      `(admin)` route group; checked on every admin request, no JWT
--      caching, so a revoked admin loses access immediately. Promotion
--      is manual SQL or `scripts/promote-admin.ts` — there's
--      intentionally no in-app path.
--
--   2. `admin_notes` table — free-form notes the admin attaches to a
--      user from the Phase 2 user-detail page. One row per note;
--      editing isn't supported (delete + rewrite). `admin_id` is
--      NOT NULL because an unattributed note has no forensic value.
--
--   3. New indexes to keep the admin dashboards under the 200ms
--      per-query budget on production data:
--
--      a. `users_created_at_idx` — newest-first signup scan (today's
--         signups, 7-day trend, 30-day funnel). Partial on
--         `deleted_at IS NULL` so the dashboard never has to filter
--         deleted rows out of an index range scan.
--      b. `users_signup_country_idx` — geo tile + non-Indian signup
--         health check. Same partial filter.
--      c. `users_admin_lookup_idx` — partial index on the per-request
--         admin-gate lookup. With only one or two admin rows the
--         index is effectively a single page.
--      d. `credit_purchases_status_created_idx` — revenue today /
--         7-day + payment-failure health check both filter by status
--         and order newest-first.
--      e. `credit_purchases_user_status_idx` — admin user-detail
--         page's "this user's succeeded purchases" lookup.
--      f. `interview_sessions_state_created_idx` — sessions-by-state-
--         by-day reads (today's complete count, 24h failure rate, 30-
--         day trend). Partial on `deleted_at IS NULL`.
--      g. `audit_log_event_type_created_idx` — admin reads pin a
--         specific event_type and page newest-first.
--
-- All indexes use `IF NOT EXISTS` so a hand-fixed environment that
-- already has some of them doesn't fail the migration. The CREATE
-- TABLE / ALTER TABLE statements do NOT use `IF NOT EXISTS` because
-- those are the load-bearing schema changes — they SHOULD fail
-- loudly if the column / table already exists, which would mean
-- the migration has already been applied incorrectly.

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;

--> statement-breakpoint
CREATE TABLE "admin_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "admin_id" uuid NOT NULL,
  "note" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "admin_notes_user_id_users_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "admin_notes_admin_id_users_id_fk" FOREIGN KEY ("admin_id")
    REFERENCES "public"."users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_notes_user_created_idx"
  ON "admin_notes" USING btree ("user_id", "created_at" DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_created_at_idx"
  ON "users" USING btree ("created_at" DESC)
  WHERE "users"."deleted_at" IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_signup_country_idx"
  ON "users" USING btree ("signup_country_code")
  WHERE "users"."deleted_at" IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_admin_lookup_idx"
  ON "users" USING btree ("is_admin")
  WHERE "users"."is_admin" = true;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_purchases_status_created_idx"
  ON "credit_purchases" USING btree ("status", "created_at" DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_purchases_user_status_idx"
  ON "credit_purchases" USING btree ("user_id", "status");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interview_sessions_state_created_idx"
  ON "interview_sessions" USING btree ("state", "created_at")
  WHERE "interview_sessions"."deleted_at" IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_event_type_created_idx"
  ON "audit_log" USING btree ("event_type", "created_at" DESC);
