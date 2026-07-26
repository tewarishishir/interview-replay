import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { withDbRetry } from "@/lib/db/retry";
import { type ProcessedTranscript } from "@/lib/whisper/process";
import type { InferenceItem } from "@/lib/llm/infer-questions";
import { assertTransitionAllowed } from "@/lib/state-machine";

/**
 * Hard ceiling we apply to any duration we ever write into
 * `transcripts.duration_seconds`. The pricing helper rejects
 * anything > 120 minutes; the column itself is an `int4` (~68 yrs);
 * but if we ever land a transcription-derived value above this cap
 * we clamp so the analyze route's 422 path is the SOLE place a user
 * sees "too long" — we never want to write a value that the rest
 * of the system will then crash on.
 */
const MAX_PERSISTED_DURATION_SECONDS = 6 * 60 * 60;

/**
 * Resolve the duration we actually write to `transcripts.duration_seconds`
 * AND back to `audio_files.duration_seconds`. The transcription-derived
 * value (server-observed audio length) is authoritative; the
 * client-reported value at finalize time is the fallback only when
 * the transcriber couldn't tell us.
 *
 * In every case the result is clamped to `MAX_PERSISTED_DURATION_SECONDS`
 * — a malicious client AND a buggy transcription response both bottom out
 * at a value the analyze route will gracefully 422 on.
 */
export function resolveAuthoritativeDuration(args: {
  fromTranscriber: number | null;
  fromClientFallback: number;
}): number {
  const candidate =
    args.fromTranscriber !== null && args.fromTranscriber > 0
      ? args.fromTranscriber
      : Math.max(0, args.fromClientFallback);
  return Math.min(candidate, MAX_PERSISTED_DURATION_SECONDS);
}

/**
 * Minimum client-reported duration we'll consider for clipped-audio
 * detection. Anything shorter is just a normal short recording — we
 * don't want to falsely flag a genuine 10-second answer as "clipped".
 */
const CLIPPED_DETECTION_MIN_CLIENT_SECONDS = 30;
/**
 * Audio-vs-client ratio threshold. If the actual audio is below this
 * fraction of what the client claimed, we treat it as clipped.
 * Generous enough that small client/server clock skew on long
 * recordings doesn't trip it.
 */
const CLIPPED_DETECTION_RATIO = 0.5;

/**
 * Detect the "recording was silently clipped" failure mode.
 *
 * Common cause: the candidate's mic disconnected mid-recording
 * (Bluetooth headset auto-sleeping, USB unplug, OS revoking
 * permission) and the browser's `MediaRecorder` didn't fire an
 * `error` event for it. The recorder timer kept ticking, the user
 * thought they were being recorded, and the resulting audio is just
 * the few seconds before the disconnect.
 *
 * The recorder now has a chunk watchdog and track-end listeners that
 * catch most of these client-side, but this server-side check is a
 * defense-in-depth so we never silently land a candidate on an empty
 * review screen with no explanation.
 *
 * Returns:
 *   - A user-facing error message if the recording looks clipped
 *   - `null` otherwise
 *
 * Exported for unit testing.
 */
export function detectClippedRecording(args: {
  clientReportedSeconds: number;
  audioDurationSeconds: number | null;
  candidateWordCount: number;
}): string | null {
  const { clientReportedSeconds, audioDurationSeconds, candidateWordCount } =
    args;
  if (audioDurationSeconds === null || audioDurationSeconds <= 0) return null;
  if (clientReportedSeconds < CLIPPED_DETECTION_MIN_CLIENT_SECONDS) return null;
  if (audioDurationSeconds >= clientReportedSeconds * CLIPPED_DETECTION_RATIO)
    return null;
  // If the transcriber extracted any words, the recording is at least
  // partially usable — the user has something to edit. Skip the
  // friendly-error path so they aren't blocked from review.
  if (candidateWordCount > 0) return null;

  const audio = Math.round(audioDurationSeconds);
  const client = Math.round(clientReportedSeconds);
  return (
    `Your recording was clipped: the timer showed ${client}s but only ${audio}s ` +
    "of audio was actually captured. The most common cause is your microphone " +
    "disconnecting mid-recording (Bluetooth headset auto-sleeping, USB mic " +
    "unplugged, or the OS revoking access). Please start a new session with a " +
    "wired or actively-used mic, and consider keeping the tab in the " +
    "foreground while recording."
  );
}

/**
 * Side-effect helpers for the transcribe-session pipeline.
 * Each one is a single DB transaction with a tightly-scoped
 * responsibility.
 *
 * Important invariants:
 *   - Every state advance is guarded by the state machine — the
 *     pipeline can NEVER skip the `transcribing → review` rule.
 *   - Audio deletion is decoupled from transcription success. The
 *     pipeline calls `markScheduledDeletion(...)` regardless of
 *     whether transcription succeeded; the privacy-SLA cron sweeper
 *     handles the actual storage delete.
 */

export interface TranscribeAudioFile {
  id: string;
  sessionId: string;
  s3Key: string;
  durationSeconds: number;
}

export class AudioFileNotFoundError extends Error {
  readonly code = "audio_file_not_found";
  constructor(readonly audioFileId: string) {
    super(`audio_files row ${audioFileId} not found`);
    this.name = "AudioFileNotFoundError";
  }
}

/**
 * Lookup the audio_files row by id, scoped to a sessionId so a
 * forged event can't make us transcribe an arbitrary row. Marks
 * `transcription_started_at` as a side effect so a re-fired event
 * shows up as a re-attempt in the audit trail.
 */
export async function loadAudioForTranscription(
  audioFileId: string,
): Promise<TranscribeAudioFile> {
  const [row] = await db
    .update(schema.audioFiles)
    .set({ transcriptionStartedAt: new Date() })
    .where(eq(schema.audioFiles.id, audioFileId))
    .returning({
      id: schema.audioFiles.id,
      sessionId: schema.audioFiles.sessionId,
      s3Key: schema.audioFiles.s3Key,
      durationSeconds: schema.audioFiles.durationSeconds,
    });
  if (!row) throw new AudioFileNotFoundError(audioFileId);
  return row;
}

/**
 * Persist the processed transcript and advance the session into
 * `review` in a single transaction. Returns the inserted transcript
 * id so the caller can include it in the audit log.
 *
 * If `transcriptionError` is non-null we still write the row (with
 * empty texts and zero metrics) — the candidate proceeds to the
 * review screen and sees the friendly error banner there. The
 * downstream report-generation step will refuse to operate on a
 * row with a non-null `transcription_error`.
 */
export async function persistTranscriptAndAdvance(args: {
  sessionId: string;
  audioFileId: string;
  /**
   * Client-reported duration from `audio_files.duration_seconds`,
   * used ONLY as a fallback when the transcriber didn't tell us the
   * real audio length. The actual value persisted is computed by
   * `resolveAuthoritativeDuration` from this and the transcription-
   * derived value on `processed`.
   *
   * On the failure path (`processed === null`, transcription_error
   * set) this is also the value that ends up in the column, since
   * we have no transcription signal to override it. Per spec we still
   * write the row so the candidate sees a friendly review screen.
   */
  durationSeconds: number;
  processed: ProcessedTranscript | null;
  transcriptionError: string | null;
  userId: string;
  /**
   * AI-inferred question chunks derived from the candidate-only
   * transcript (Haiku pass). When present and non-empty, each entry
   * lands as an `artifacts` row with `source = 'ai_inferred'` and
   * the linked transcript pointers set so the review screen can
   * position the card next to the right span.
   *
   * All three confidence bands (`high`, `medium`, `low`) are
   * persisted and surfaced to the candidate as suggestion cards
   * — each card displays its band so the candidate can decide
   * whether to confirm or dismiss. The candidate is the gate, not
   * the worker.
   */
  inferredQuestions?: InferenceItem[];
}): Promise<{ transcriptId: string }> {
  assertTransitionAllowed("transcribing", "review");

  const processed = args.processed;

  // Authoritative duration: transcription measurement when available,
  // clamped to the 6h ceiling. The client value is only used as a
  // fallback. This is the load-bearing fix for "client tampers with
  // duration_seconds to dodge billing" — once this column is set
  // from the transcriber, the analyze route's `creditsForDuration` reads
  // a server-trusted value.
  const authoritativeDuration = resolveAuthoritativeDuration({
    fromTranscriber: processed?.audioDurationSeconds ?? null,
    fromClientFallback: args.durationSeconds,
  });

  // Detect "audio was clipped client-side" — the recorder timer ran
  // much longer than the actual captured audio. The most common
  // cause is a silent microphone disconnect during recording
  // (Bluetooth headset auto-sleeping, USB mic unplugged, OS revoking
  // access mid-stream) that the browser's MediaRecorder didn't fire
  // an `error` for. Without this detection the candidate sees an
  // empty review screen and assumes transcription broke — they
  // don't realize the recording itself was clipped to a few seconds.
  //
  // Heuristic:
  //   - We have a transcription measurement (so we know the truth).
  //   - The client said the recording was at least 30s long
  //     (legit short recordings shouldn't trip this).
  //   - The actual audio is less than 50% of what the client claimed.
  //   - And the transcriber produced zero candidate words (so the user has
  //     no transcript to fall back on).
  // We also leave any pre-existing `transcriptionError` in place —
  // a real transcription failure is more informative than our heuristic.
  const clippedAudioError = detectClippedRecording({
    clientReportedSeconds: args.durationSeconds,
    audioDurationSeconds: processed?.audioDurationSeconds ?? null,
    candidateWordCount: processed?.candidateWordCount ?? 0,
  });
  const derivedTranscriptionError =
    args.transcriptionError ?? clippedAudioError;

  const transcriptValues = {
    sessionId: args.sessionId,
    rawText: processed?.rawText ?? "",
    redactedText: processed?.redactedText ?? "",
    redactionCount: processed?.redactionCount ?? 0,
    language: "en",
    wordCount: processed?.candidateWordCount ?? 0,
    durationSeconds: authoritativeDuration,
    fillerWordCount: processed?.candidateFillerWordCount ?? 0,
    transcriptionError: derivedTranscriptionError,
  } as const;

  return db.transaction(async (tx) => {
    // Idempotency: if a previous attempt already wrote the
    // transcript, short-circuit so we don't explode on the
    // unique(session_id) constraint. Returning the existing id is
    // correct — audio deletion is also idempotent, and the session
    // is already in `review` so the state UPDATE would no-op.
    const [existing] = await tx
      .select({ id: schema.transcripts.id })
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, args.sessionId))
      .limit(1);
    if (existing) {
      return { transcriptId: existing.id };
    }

    const [transcript] = await tx
      .insert(schema.transcripts)
      .values(transcriptValues)
      .returning({ id: schema.transcripts.id });
    if (!transcript) {
      throw new Error(
        `persistTranscriptAndAdvance: transcripts INSERT returned no row for session ${args.sessionId}`,
      );
    }

    const [session] = await tx
      .update(schema.interviewSessions)
      .set({ state: "review", updatedAt: new Date() })
      .where(
        and(
          eq(schema.interviewSessions.id, args.sessionId),
          eq(schema.interviewSessions.state, "transcribing"),
        ),
      )
      .returning({ id: schema.interviewSessions.id });
    if (!session) {
      // Roll the transcript insert back: a session that's somehow
      // not in `transcribing` (deleted concurrently, re-fired event
      // landed late) shouldn't end up with a duplicate transcript.
      throw new Error(
        `persistTranscriptAndAdvance: state guard failed for session ${args.sessionId}`,
      );
    }

    // Also overwrite `audio_files.duration_seconds` with the
    // authoritative value so the two columns can't drift. The
    // client's value is no longer trusted past this point.
    await tx
      .update(schema.audioFiles)
      .set({
        transcriptionCompletedAt: new Date(),
        durationSeconds: authoritativeDuration,
      })
      .where(eq(schema.audioFiles.id, args.audioFileId));

    /* AI-inferred question artifacts.
     *
     * Inserted in the SAME transaction as the transcript so a worker
     * crash mid-flight can never land in a state where the candidate
     * sees a transcript without the inferred cards their review UI
     * was built around.
     *
     * All three confidence bands (high/medium/low) are written and
     * shown to the candidate. Each card displays its band as a
     * color-coded pill so the candidate can decide whether to
     * confirm or dismiss without us pre-filtering anything.
     *
     * The `displayOrder` mirrors the position in the transcript so
     * the augment screen renders the cards in the same top-to-bottom
     * order as the answers they refer to.
     */
    const inferred = args.inferredQuestions ?? [];
    if (inferred.length > 0 && !args.transcriptionError) {
      await tx.insert(schema.artifacts).values(
        inferred.map((item, index) => ({
          sessionId: args.sessionId,
          artifactType: "question" as const,
          content: item.inferred_question,
          imageUrl: null,
          displayOrder: index,
          source: "ai_inferred" as const,
          aiConfidence: item.confidence,
          linkedTranscriptOffset: item.transcript_offset,
          linkedTranscriptLength: item.transcript_length,
        })),
      );
    }

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: args.transcriptionError
        ? "session.transcription.failed"
        : "session.transcription.completed",
      eventData: {
        sessionId: args.sessionId,
        audioFileId: args.audioFileId,
        transcriptId: transcript.id,
        redactionCount: processed?.redactionCount ?? 0,
        durationSeconds: authoritativeDuration,
        inferredQuestionCount: inferred.length,
        // Capture the client-reported value alongside the
        // transcription-derived one when they disagree, so a forensic
        // review can spot a client trying to under-report duration.
        ...(authoritativeDuration !== args.durationSeconds
          ? { clientReportedDurationSeconds: args.durationSeconds }
          : {}),
        ...(args.transcriptionError
          ? { error: args.transcriptionError }
          : {}),
      },
    });

    return { transcriptId: transcript.id };
  });
}

/**
 * Update `audio_files.scheduled_deletion_at` to `now() + 60s` per
 * the spec. Returns the new scheduled time so the orchestrator can
 * pass it into `scheduleAudioDeletion`. We always do this AFTER the
 * transcript is persisted so a worker crash mid-flight doesn't move
 * the deletion deadline forward without a transcript landing.
 */
export async function markScheduledDeletion(
  audioFileId: string,
  delaySeconds = 60,
): Promise<Date> {
  const scheduledDeletionAt = new Date(Date.now() + delaySeconds * 1000);
  await db
    .update(schema.audioFiles)
    .set({ scheduledDeletionAt })
    .where(eq(schema.audioFiles.id, audioFileId));
  return scheduledDeletionAt;
}

/**
 * Used by the `delete-audio` worker (and the SLA cron) to atomically
 * mark an audio_files row deleted and emit the audit row in one
 * transaction. Returns `false` if the row was already deleted —
 * the caller treats that as a no-op rather than an error.
 *
 * `userId` is optional: the SLA cron may not have a session context
 * when it sweeps an orphaned row.
 */
export async function recordAudioDeletion(args: {
  audioFileId: string;
  userId?: string | null;
  s3Key: string;
  reason: "scheduled" | "sla_enforcement";
  /**
   * Optional count of storage file versions the caller
   * removed. Surfaced in the audit row's eventData so an
   * investigator chasing a "file still there in storage" report can pivot
   * straight from audit_log to the filesystem without having to re-run an
   * inventory: a `versionsDeleted: 0` row means the worker ran but
   * found nothing under the key (real or apparent), which is the
   * smoking-gun shape for a key-drift or versioning misconfiguration.
   */
  versionsDeleted?: number;
}): Promise<boolean> {
  // Retried on transient Neon connection blips. Safe because the whole
  // body is one transaction guarded by `deleted_at IS NULL`: if a
  // retry runs after a prior attempt already committed (e.g. the
  // connection dropped on the commit ack), the UPDATE matches no row
  // and we return `false` — no double audit-log entry.
  return withDbRetry(
    () =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.audioFiles)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(schema.audioFiles.id, args.audioFileId),
              // Idempotent: a row already marked deleted is a no-op.
              // Both the scheduled `delete-audio` worker and the SLA
              // sweeper can race on the same row; the loser drops out
              // here without an error or a duplicate audit row.
              isNull(schema.audioFiles.deletedAt),
            ),
          )
          .returning({ id: schema.audioFiles.id });

        if (!row) return false;

        await tx.insert(schema.auditLog).values({
          userId: args.userId ?? null,
          eventType: "audio.deleted",
          eventData: {
            audioFileId: args.audioFileId,
            s3Key: args.s3Key,
            reason: args.reason,
            ...(args.versionsDeleted != null
              ? { versionsDeleted: args.versionsDeleted }
              : {}),
          },
        });

        return true;
      }),
    { label: "recordAudioDeletion" },
  );
}
