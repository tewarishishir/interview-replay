-- Realign `interview_session_state` to the product-spec values.
--
-- Renames `pending` → `created` and `completed` → `complete`, and adds
-- `review` and `deleted`. The state machine in
-- `src/lib/state-machine.ts` references the new names; without this
-- migration the API would 500 the moment it tried to insert a session.
--
-- Notes:
--   * `ALTER TYPE ... RENAME VALUE` rewrites every existing row in
--     place — no per-row UPDATE needed.
--   * `ADD VALUE IF NOT EXISTS` is idempotent so re-running this
--     migration is safe (e.g. against a partially-migrated DB).
--   * The default is dropped and re-added because Postgres binds the
--     literal token `'pending'` into the column default, and
--     re-pointing it to `'created'` requires an explicit ALTER COLUMN.

ALTER TYPE "public"."interview_session_state" RENAME VALUE 'pending' TO 'created';--> statement-breakpoint
ALTER TYPE "public"."interview_session_state" RENAME VALUE 'completed' TO 'complete';--> statement-breakpoint
ALTER TYPE "public"."interview_session_state" ADD VALUE IF NOT EXISTS 'review';--> statement-breakpoint
ALTER TYPE "public"."interview_session_state" ADD VALUE IF NOT EXISTS 'deleted';--> statement-breakpoint
ALTER TABLE "interview_sessions" ALTER COLUMN "state" SET DEFAULT 'created';
