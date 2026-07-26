-- Per-question analytics surfaces new launch contexts for Practice
-- Rebuild: the Analytics tab's per-question card pins a specific
-- artifact (question) and optionally a profile item to pre-select on
-- Step 3 of the rebuild flow.
--
-- 1. `source_artifact_id` (UUID, nullable) — REFERENCES artifacts(id)
--    with ON DELETE SET NULL. The artifact retention sweep should not
--    cascade-drop the rebuild row; the candidate's draft outlives the
--    source artifact (same trade-off `source_session_id` makes).
--
-- 2. `pre_selected_profile_item_id` (UUID, nullable) — intentionally
--    NOT a Postgres FK because it can point at EITHER `projects.id`
--    OR `stories.id` and Postgres doesn't support disjunctive FKs
--    without a polymorphic join table. The application's create-
--    rebuild route verifies the UUID belongs to one of the user's
--    `projects` or `stories` rows before insert; this column is a
--    hint for the UI, not a source of truth.
--
-- Both columns default to NULL and are skipped on every existing row
-- (no backfill — the rebuilds that pre-date the Analytics tab had no
-- artifact pin and no pre-selected item).
--
-- An index on `source_artifact_id` lets the report page's "show all
-- rebuilds anchored on this question" lookup stay cheap; the
-- profile-item id has no anchored read path yet (UI presents the
-- pre-selection on the rebuild detail page, which already joins by
-- rebuild id) so we hold off on indexing it.

ALTER TABLE "story_rebuilds"
  ADD COLUMN "source_artifact_id" uuid;

ALTER TABLE "story_rebuilds"
  ADD COLUMN "pre_selected_profile_item_id" uuid;

ALTER TABLE "story_rebuilds"
  ADD CONSTRAINT "story_rebuilds_source_artifact_id_artifacts_id_fk"
  FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE INDEX IF NOT EXISTS "story_rebuilds_artifact_idx"
  ON "story_rebuilds" USING btree ("source_artifact_id")
  WHERE "source_artifact_id" IS NOT NULL;
