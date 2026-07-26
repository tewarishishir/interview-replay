-- Price drop: rebuild-critique and AI-draft cost 0.25 → 0.20 credits.
-- Implementation: bump REBUILD_CRITIQUE_UNITS_PER_CREDIT from 4 to 5
-- in src/lib/credits/pricing.ts (display cost is 1/N).
--
-- The accumulator column `users.rebuild_critique_units` carries the
-- in-flight units before the next rollover-and-charge. Its CHECK
-- constraint must widen from `< 4` to `< 5` to match the new N. This
-- migration MUST run BEFORE the code with the new constant deploys —
-- otherwise a user at units=3 trying to record a 4th critique will
-- have the new code write units=4 (no rollover yet, since N is now
-- 5), and the OLD constraint will reject it as out-of-range.
--
-- Existing rows are all in `[0, 4)`, which is a subset of the new
-- range `[0, 5)`, so no data backfill is needed. Users sitting at
-- units in {0..3} when the new code lands get a one-time partial
-- benefit (one extra critique before their next rollover), which is
-- the right side of the trade-off during a price drop.

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_rebuild_critique_units_range";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_rebuild_critique_units_range" CHECK ("users"."rebuild_critique_units" >= 0 AND "users"."rebuild_critique_units" < 5);
