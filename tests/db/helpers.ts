import { sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * Per-test reset: delete from every table in dependency order so each
 * test sees a clean DB without paying for `TRUNCATE ... RESTART IDENTITY`,
 * which serializes against connections and is much slower.
 *
 * Sequences are reset for the bigserial tables so `id` values stay
 * deterministic across tests.
 */
export async function resetDatabase(): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      ${schema.dataExports},
      ${schema.creditTransactions},
      ${schema.creditPurchases},
      ${schema.adminNotes},
      ${schema.auditLog},
      ${schema.userPatterns},
      ${schema.storyRebuilds},
      ${schema.reports},
      ${schema.artifacts},
      ${schema.audioFiles},
      ${schema.transcripts},
      ${schema.sessionOutcomes},
      ${schema.feedback},
      ${schema.interviewSessions},
      ${schema.resumeParseJobs},
      ${schema.stories},
      ${schema.projects},
      ${schema.userProfiles},
      ${schema.authSessions},
      ${schema.accounts},
      ${schema.verificationTokens},
      ${schema.users}
    RESTART IDENTITY CASCADE
  `);
}

let migrationsApplied = false;

/**
 * Best-effort sanity check that the test DB has the schema applied.
 * If the `users` table doesn't exist we throw with a helpful hint
 * rather than letting the first INSERT fail with a cryptic 42P01.
 */
export async function ensureSchema(): Promise<void> {
  if (migrationsApplied) return;

  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users'
    ) AS exists
  `);
  const exists = result.rows[0]?.exists ?? false;

  if (!exists) {
    throw new Error(
      "Test DB missing the `users` table.\n" +
        "Apply migrations first: pnpm db:migrate (with DATABASE_URL pointing at your local Postgres).",
    );
  }

  migrationsApplied = true;
}
