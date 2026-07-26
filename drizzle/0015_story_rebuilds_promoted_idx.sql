-- Story Bank top-level page reads stories LEFT JOINed against
-- `story_rebuilds.promoted_to_story_id` so each saved-from-rebuild
-- story can surface its critique + source-session backlink without
-- a per-story round-trip.
--
-- The FK on `promoted_to_story_id` doesn't automatically create an
-- index in Postgres, so we add an explicit partial index keyed
-- only on the non-NULL rows (the vast majority of `story_rebuilds`
-- rows are still in_progress / critiqued and haven't been
-- promoted; including them in the index would just cost write
-- amplification with no read benefit).
CREATE INDEX IF NOT EXISTS "story_rebuilds_promoted_to_story_idx"
  ON "story_rebuilds" ("promoted_to_story_id")
  WHERE "promoted_to_story_id" IS NOT NULL;
