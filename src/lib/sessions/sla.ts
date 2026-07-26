import "server-only";

import { and, isNull, lt, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { withDbRetry } from "@/lib/db/retry";

/**
 * Read-side helpers for the privacy-SLA enforcement cron. Returns
 * the candidate rows the cron then individually walks through (storage
 * delete + DB mark + audit log).
 *
 * Two distinct queries because the spec splits the response into
 * two reactions:
 *
 *   1. ANY row with `scheduled_deletion_at < now() AND deleted_at
 *      IS NULL` — the scheduled `delete-audio` event was lost,
 *      sweep it now.
 *   2. ANY row with `scheduled_deletion_at < now() - 1 hour AND
 *      deleted_at IS NULL` — privacy SLA breach. Even after the
 *      sweep above runs, we want operators paged because we promised
 *      the candidate the file would be gone within 60 seconds, not
 *      an hour later. Logging-only is the default in dev (no
 *      webhook configured); production wires a Slack/PagerDuty URL
 *      via `PRIVACY_SLA_ALERT_WEBHOOK_URL`.
 */

export interface SlaSweepRow {
  id: string;
  s3Key: string;
  sessionId: string;
  scheduledDeletionAt: Date;
}

/**
 * All audio_files past their deletion deadline. The query hits the
 * partial index `audio_files_scheduled_deletion_idx` (defined in
 * `lib/db/schema/interviews.ts`) so the table scan is bounded to
 * the small set of "still living" rows.
 *
 * `now` is exposed so tests can pin the clock.
 */
export async function findOverdueAudioFiles(args?: {
  now?: Date;
  limit?: number;
}): Promise<SlaSweepRow[]> {
  const now = args?.now ?? new Date();
  const limit = Math.max(1, Math.min(500, args?.limit ?? 100));

  // Read-only + retried: a transient Neon connection blip (cold-start,
  // compute recycle, network hiccup) must not fail the SLA cron tick.
  return withDbRetry(
    () =>
      db
        .select({
          id: schema.audioFiles.id,
          s3Key: schema.audioFiles.s3Key,
          sessionId: schema.audioFiles.sessionId,
          scheduledDeletionAt: schema.audioFiles.scheduledDeletionAt,
        })
        .from(schema.audioFiles)
        .where(
          and(
            lt(schema.audioFiles.scheduledDeletionAt, now),
            isNull(schema.audioFiles.deletedAt),
          ),
        )
        .limit(limit),
    { label: "findOverdueAudioFiles" },
  );
}

/**
 * Subset of the overdue rows that have blown through the 1-hour
 * grace period. These get the alert webhook treatment in addition
 * to the regular delete sweep.
 *
 * Implemented as a separate query (vs. filtering the previous list
 * in JS) so the count we report comes from the index directly. The
 * cron emits this count even if the alert webhook isn't configured —
 * downstream metrics dashboards rely on it.
 */
export async function countSlaBreaches(now: Date = new Date()): Promise<number> {
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  // Read-only + retried: this is the cron's FIRST DB call, so it's the
  // one most exposed to a cold/recycling Neon compute. A one-tick
  // connection blip here used to fail the whole run and page an
  // operator; the in-process retry absorbs it.
  const rows = await withDbRetry(
    () =>
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(schema.audioFiles)
        .where(
          and(
            lt(schema.audioFiles.scheduledDeletionAt, oneHourAgo),
            isNull(schema.audioFiles.deletedAt),
          ),
        ),
    { label: "countSlaBreaches" },
  );
  return rows[0]?.c ?? 0;
}
