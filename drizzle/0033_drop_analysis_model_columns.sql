-- Rollback: drop analysis_model tracking columns added in 0032.
-- These columns were used by the Opus selective routing feature (Prompt 1)
-- which has been reverted. Historical rows with these columns are safe to
-- drop — the UI and API never read them directly.

ALTER TABLE "reports" DROP COLUMN IF EXISTS "analysis_model";
ALTER TABLE "reports" DROP COLUMN IF EXISTS "analysis_model_selection_reason";
