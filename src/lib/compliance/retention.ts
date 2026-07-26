import "server-only";

import { and, eq, isNull, lt } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { deleteFile } from "@/lib/storage/delete";
import { StorageNotConfiguredError } from "@/lib/storage";
import { recordAudioDeletion } from "@/lib/sessions/transcribe";

/**
 * Session-level audio cleanup backstop. Distinct from the primary
 * audio-deletion path (event-driven, 60-second SLA) and the
 * 5-minute SLA sweeper: this daily job is a final safety net that
 * catches any audio files whose `scheduled_deletion_at` has passed
 * but were missed by both earlier stages.
 *
 * Transcripts, artifacts, outcomes, and the session row itself are
 * NEVER deleted by this function. Only audio file storage objects are
 * removed. All other session data lives until the user explicitly
 * deletes their account.
 */

export interface ExpiredSessionRow {
  sessionId: string;
  userId: string;
  retentionUntil: Date;
}

/**
 * Sessions whose `retention_until` has passed and that haven't
 * already been soft-deleted. Limited to a daily batch size — the
 * cron iterates serially so a poison row doesn't stall the rest.
 */
export async function findRetentionExpiredSessions(args?: {
  now?: Date;
  limit?: number;
}): Promise<ExpiredSessionRow[]> {
  const now = args?.now ?? new Date();
  const limit = Math.max(1, Math.min(1000, args?.limit ?? 200));

  return db
    .select({
      sessionId: schema.interviewSessions.id,
      userId: schema.interviewSessions.userId,
      retentionUntil: schema.interviewSessions.retentionUntil,
    })
    .from(schema.interviewSessions)
    .where(
      and(
        lt(schema.interviewSessions.retentionUntil, now),
        isNull(schema.interviewSessions.deletedAt),
      ),
    )
    .limit(limit);
}

export interface EnforceSessionRetentionResult {
  sessionId: string;
  /** Audio storage keys we attempted to delete. */
  audioKeysAttempted: string[];
  /** Audio rows marked deleted in the DB. */
  audioRowsMarkedDeleted: number;
}

/**
 * Thrown when one or more audio storage deletes fail. The caller (the
 * retention cron) catches this and counts it as a per-row failure so
 * the next daily tick retries the same session — the audio_files
 * row stays `deleted_at IS NULL`, which keeps it visible to the
 * 5-minute SLA sweeper too.
 *
 * Distinct from "transcripts/artifacts deleted but session not
 * soft-deleted" because that combo would be a worse half-state to
 * recover from.
 */
export class RetentionStorageCleanupError extends Error {
  readonly s3Key: string;
  constructor(s3Key: string, cause: unknown) {
    super(
      `enforceSessionRetention: storage delete failed for ${s3Key} — refusing to mark row deleted (would orphan the file).`,
    );
    this.name = "RetentionStorageCleanupError";
    this.s3Key = s3Key;
    if (cause instanceof Error) this.cause = cause;
  }
}

/**
 * Audio-only backstop for a single session. Finds any audio_files
 * rows still undeleted and performs the storage + DB cleanup.
 *
 * Transcripts, artifacts, outcomes, and the session row are NOT
 * touched — they are kept indefinitely until the user deletes their
 * account.
 *
 * Order matters:
 *   1. Look up audio_files rows with deleted_at IS NULL.
 *   2. Storage delete for each. On failure (other than StorageNotConfiguredError)
 *      we throw RetentionStorageCleanupError — the row stays undeleted so
 *      the 5-minute SLA sweeper retries, AND the next daily tick
 *      retries the same session.
 *   3. ONLY on storage success, mark the audio_files row deleted (audit
 *      log row written inside recordAudioDeletion).
 */
export async function enforceSessionRetention(args: {
  sessionId: string;
  userId: string;
}): Promise<EnforceSessionRetentionResult> {
  const audioRows = await db
    .select({
      id: schema.audioFiles.id,
      s3Key: schema.audioFiles.s3Key,
    })
    .from(schema.audioFiles)
    .where(
      and(
        eq(schema.audioFiles.sessionId, args.sessionId),
        isNull(schema.audioFiles.deletedAt),
      ),
    );

  const audioKeysAttempted: string[] = [];
  let audioRowsMarkedDeleted = 0;

  for (const audio of audioRows) {
    audioKeysAttempted.push(audio.s3Key);
    try {
      await deleteFile(audio.s3Key);
    } catch (err) {
      if (err instanceof StorageNotConfiguredError) {
        // Dev / no-storage env: nothing remote to delete. Fall through
        // to mark the row deleted so this tick doesn't re-discover it.
      } else {
        console.error(
          `[enforceSessionRetention] storage delete failed for ${audio.s3Key} — leaving audio_files row for SLA sweeper retry`,
          err,
        );
        throw new RetentionStorageCleanupError(audio.s3Key, err);
      }
    }

    const marked = await recordAudioDeletion({
      audioFileId: audio.id,
      userId: args.userId,
      s3Key: audio.s3Key,
      reason: "sla_enforcement",
    });
    if (marked) audioRowsMarkedDeleted++;
  }

  return {
    sessionId: args.sessionId,
    audioKeysAttempted,
    audioRowsMarkedDeleted,
  };
}

/**
 * Per-spec rebuild retention window: drafts the user explicitly
 * discarded sit in `status='discarded'` for 30 days so the user
 * can fish them out of the trash if they change their mind, then
 * are hard-deleted.
 *
 * Why hard-delete and not soft-delete: discarded rebuilds carry
 * encrypted text (question, headline, STAR fields). Keeping them
 * on disk past the retention window for an audit trail buys us
 * nothing — the rebuild was never the canonical record (the
 * promoted `user_stories` row is). Audit lineage is captured by
 * the per-row `audit_log` entry below.
 */
export const REBUILD_DISCARD_RETENTION_DAYS = 30;

export interface ExpiredRebuildRow {
  rebuildId: string;
  userId: string;
  updatedAt: Date;
}

export async function findRetentionExpiredRebuilds(args?: {
  now?: Date;
  limit?: number;
}): Promise<ExpiredRebuildRow[]> {
  const now = args?.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - REBUILD_DISCARD_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const limit = Math.max(1, Math.min(1000, args?.limit ?? 200));

  return db
    .select({
      rebuildId: schema.storyRebuilds.id,
      userId: schema.storyRebuilds.userId,
      updatedAt: schema.storyRebuilds.updatedAt,
    })
    .from(schema.storyRebuilds)
    .where(
      and(
        eq(schema.storyRebuilds.status, "discarded"),
        lt(schema.storyRebuilds.updatedAt, cutoff),
      ),
    )
    .limit(limit);
}

export interface PurgeRebuildResult {
  rebuildId: string;
  /** True when the row was found + deleted, false on a no-op. */
  deleted: boolean;
}

/**
 * Hard-delete a single discarded rebuild and write an audit row.
 * Idempotent: a re-run after a successful delete returns
 * `{ deleted: false }` rather than throwing — the cron treats
 * that as a no-op and moves on.
 *
 * The audit row records ONLY the rebuild id + the user id. We
 * deliberately don't capture the encrypted text fields (or any
 * derived metadata) — the whole point of the retention sweep is
 * that this content is gone.
 */
export async function purgeDiscardedRebuild(args: {
  rebuildId: string;
  userId: string;
}): Promise<PurgeRebuildResult> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(schema.storyRebuilds)
      .where(
        and(
          eq(schema.storyRebuilds.id, args.rebuildId),
          eq(schema.storyRebuilds.userId, args.userId),
          eq(schema.storyRebuilds.status, "discarded"),
        ),
      )
      .returning({ id: schema.storyRebuilds.id });

    if (deleted.length === 0) return { rebuildId: args.rebuildId, deleted: false };

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "rebuild.retention.purged",
      eventData: { rebuildId: args.rebuildId },
    });

    return { rebuildId: args.rebuildId, deleted: true };
  });
}
