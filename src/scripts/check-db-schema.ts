/**
 * Pre/post-deploy schema sanity check.
 *
 * Connects to the target database and verifies that every column
 * referenced by the Drizzle schema actually exists in the live DB.
 * Run this BEFORE and AFTER any production promotion to catch
 * "code deployed without migrations" outages like the 2026-06-01 incident.
 *
 * Usage:
 *   # Against staging
 *   DATABASE_URL=<staging_url> npx tsx --conditions=react-server src/scripts/check-db-schema.ts
 *
 *   # Against production
 *   DATABASE_URL=<prod_url> npx tsx --conditions=react-server src/scripts/check-db-schema.ts
 *
 * Exit code 0 = all columns present.
 * Exit code 1 = at least one column is missing — DO NOT DEPLOY.
 */

import { Client } from "pg";

// ─── Expected schema ────────────────────────────────────────────────────────
// These are the columns most at risk of drifting between staging and
// production (i.e. columns added in recent migrations). Use DB snake_case
// names (not Drizzle camelCase).  Add a new entry whenever you write a
// migration that adds a column — a short comment with the migration number
// is enough to explain the rationale.
const EXPECTED: Record<string, string[]> = {
  interview_sessions: [
    "id", "user_id", "company_name", "role_title", "level",
    "round_type", "state", "created_at", "updated_at", "deleted_at",
  ],
  transcripts: [
    "id", "session_id", "raw_text", "word_count", "duration_seconds",
    "edited_text", "created_at", "updated_at",
  ],
  artifacts: [
    "id", "session_id", "artifact_type", "content", "display_order",
    "created_at", "source", "ai_confidence", "user_confirmed_at", "dismissed_at",
  ],
  reports: [
    "id", "session_id", "report_json", "model_version",
    "rubric_version", "created_at",
  ],
  session_outcomes: [
    // Core columns present since table was created
    "id", "session_id", "outcome_type", "outcome_received_at",
    "recorded_at", "next_round_type", "feedback_received",
    "reflection_notes", "would_change", "created_at", "updated_at",
    // Added migration 0031 — caused 2026-06-01 production outage when missing
    "asked_for_feedback",
  ],
  story_rebuilds: [
    "id", "user_id", "source_session_id", "source_improvement_index",
    "question_text", "question_theme", "headline",
    "situation", "task", "action", "result", "what_i_would_change",
    "ai_critique_json", "critique_history",
    "ai_suggested_response_json", "ai_suggested_response_model_version",
    "ai_suggested_response_generated_at", "suggested_response_history",
    "promoted_to_story_id", "status", "created_at", "updated_at",
    "source_artifact_id", "pre_selected_profile_item_id",
  ],
  stories: [
    "id", "user_id", "title", "theme", "situation", "task",
    "action", "result", "created_at", "updated_at",
    "ai_suggested_response_json",
  ],
  users: [
    "id", "display_name", "email", "email_verified",
    "credit_balance", "created_at", "updated_at", "deleted_at",
  ],
};

// ─── CHECK CONSTRAINTS that must exist ──────────────────────────────────────
// Maps table → partial string that must appear in the constraint definition.
// Catches the "rejected still allowed" class of bug.
const EXPECTED_CONSTRAINTS: Record<string, { name: string; mustContain: string }[]> = {
  session_outcomes: [
    {
      name: "session_outcomes_outcome_type_valid",
      mustContain: "did_not_advance",
    },
  ],
};

// ─── Runner ─────────────────────────────────────────────────────────────────

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("❌  DATABASE_URL is not set");
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  let failures = 0;

  try {
    console.log("🔍  Checking schema against live DB…\n");

    // 1. Column existence
    for (const [table, cols] of Object.entries(EXPECTED)) {
      const { rows } = await client.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = 'public'`,
        [table],
      );
      const present = new Set(rows.map((r) => r.column_name));
      const missing = cols.filter((c) => !present.has(c));

      if (missing.length === 0) {
        console.log(`  ✅  ${table}`);
      } else {
        console.error(`  ❌  ${table} — missing columns: ${missing.join(", ")}`);
        failures++;
      }
    }

    // 2. CHECK constraint values
    console.log("");
    for (const [table, checks] of Object.entries(EXPECTED_CONSTRAINTS)) {
      for (const { name, mustContain } of checks) {
        const { rows } = await client.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
           WHERE conrelid = $1::regclass AND conname = $2`,
          [table, name],
        );
        const row = rows[0];
        if (!row) {
          console.error(`  ❌  ${table}.${name} — constraint not found`);
          failures++;
        } else if (!row.def.includes(mustContain)) {
          console.error(
            `  ❌  ${table}.${name} — constraint does not contain '${mustContain}'`,
          );
          console.error(`       Current: ${row.def}`);
          failures++;
        } else {
          console.log(`  ✅  ${table}.${name}`);
        }
      }
    }
  } finally {
    await client.end();
  }

  console.log("");
  if (failures === 0) {
    console.log("✅  All schema checks passed — safe to deploy / deploy verified.");
    process.exit(0);
  } else {
    console.error(
      `❌  ${failures} check(s) failed — apply pending migrations before deploying.`,
    );
    console.error(
      "    Run:  DATABASE_URL=<target_url> npm run db:migrate",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
