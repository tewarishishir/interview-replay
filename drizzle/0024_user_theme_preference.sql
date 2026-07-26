-- Light/dark theme support: per-user persisted preference.
--
-- A text column on `users` holding one of three values:
--   - 'system' (default): follow the OS-level `prefers-color-scheme`,
--     resolved client-side on each load.
--   - 'light' / 'dark': explicit override, persisted so the choice
--     follows the user across devices.
--
-- Stored as TEXT (not an enum) because the set is tiny + stable and
-- the API endpoint validates against a Zod literal union. An enum
-- would force a destructive type rewrite to add a fourth mode (e.g.
-- 'high-contrast') later.
--
-- The CHECK constraint pins the column to the three known values so
-- a buggy write path can't land an unrecognized string the front-end
-- would then render as a blank theme.
--
-- Existing rows backfill via the column default — no separate UPDATE
-- needed.

ALTER TABLE "users"
  ADD COLUMN "theme_preference" text NOT NULL DEFAULT 'system';

ALTER TABLE "users"
  ADD CONSTRAINT "users_theme_preference_value"
  CHECK ("theme_preference" IN ('light', 'dark', 'system'));
