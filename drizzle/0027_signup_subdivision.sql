-- Per-user subdivision (state/province) code captured at signup time.
--
-- This unlocks the admin Users surface's "Maharashtra, IN" / "Karnataka,
-- IN" geography column and the Phase 3 Health geo-monitoring breakdown.
-- The column is populated from MaxMind GeoLite2-City; environments that
-- only have the smaller Country DB installed will keep the column NULL
-- (no operational impact — the admin UI falls back to country-only
-- rendering in that case).
--
-- No backfill: historical rows stamped before this migration didn't
-- record subdivision data at signup, and re-resolving them from the
-- audit-log IP would be lossy + expensive. The column populates
-- prospectively from the next signup forward.

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_subdivision_code" text;
