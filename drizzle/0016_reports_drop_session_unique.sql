-- Re-analysis no longer overwrites the prior report. Each successful
-- analysis appends a new `reports` row instead of UPSERTing. The user
-- paid for each run, so each run is preserved for the lifetime of the
-- session (cascades unchanged).
--
-- Schema-level changes:
--   1. Drop UNIQUE("session_id") so multiple reports per session are
--      legal.
--   2. Replace the implicit unique-index lookup with an explicit
--      composite index on (session_id, created_at DESC). The session
--      detail page reads "latest" with LIMIT 1 ORDER BY created_at
--      DESC and "previous" with LIMIT 1 OFFSET 1 — both served by
--      this single index without a sort step.
--
-- No data backfill: every existing session has exactly one report
-- row, which becomes the "current" by default. The "View previous
-- analysis" link only appears once a session has been re-analyzed
-- post-deploy.
--
-- Rollback note: re-adding UNIQUE(session_id) would fail for any
-- session that has been re-analyzed after this deploy. A downgrade
-- would have to first delete all but the latest row per session.
ALTER TABLE "reports" DROP CONSTRAINT "reports_session_id_unique";--> statement-breakpoint

CREATE INDEX "reports_session_created_idx" ON "reports" USING btree ("session_id", "created_at" DESC);
