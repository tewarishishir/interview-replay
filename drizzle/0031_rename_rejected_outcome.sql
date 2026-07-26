-- Migration 0031: rename 'rejected' → 'did_not_advance' in session_outcomes
-- and add asked_for_feedback column.

-- 1. Drop the existing CHECK constraint (handle both names that may exist
--    across environments).
ALTER TABLE session_outcomes
  DROP CONSTRAINT IF EXISTS session_outcomes_outcome_type_check;

ALTER TABLE session_outcomes
  DROP CONSTRAINT IF EXISTS session_outcomes_outcome_type_valid;

-- 2. Migrate existing data: any row recorded as 'rejected' becomes 'did_not_advance'.
UPDATE session_outcomes
  SET outcome_type = 'did_not_advance'
  WHERE outcome_type = 'rejected';

-- 3. Re-add the CHECK constraint (use the name that matches production).
ALTER TABLE session_outcomes
  ADD CONSTRAINT session_outcomes_outcome_type_valid
  CHECK (outcome_type IN (
    'advanced_to_next_round',
    'received_offer',
    'did_not_advance',
    'withdrew',
    'no_response',
    'other'
  ));

-- 4. Add the new asked_for_feedback column.
--    Defaults FALSE; NULL is not used because a known "I didn't ask"
--    is semantically different from "unknown whether they asked".
ALTER TABLE session_outcomes
  ADD COLUMN IF NOT EXISTS asked_for_feedback BOOLEAN NOT NULL DEFAULT FALSE;
