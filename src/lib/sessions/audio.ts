import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  AudioFile,
  InterviewSession,
  InterviewSessionState,
} from "@/lib/db/schema";
import { assertTransitionAllowed } from "@/lib/state-machine";

/**
 * Server-side helpers for the audio recording lifecycle.
 *
 * Two transitions land here:
 *   1. `created → recording` when the recorder requests an upload URL
 *      (the user has actually started recording at that point).
 *   2. `recording → transcribing` when the upload finishes and the
 *      `audio_files` row is written.
 *
 * Both use a guarded UPDATE: `WHERE state = '<expected>'`. If a
 * concurrent request already advanced the row, the UPDATE returns
 * zero rows and the helper throws a typed error so the API route
 * can return 409 cleanly.
 *
 * Both also write an audit-log row inside their transaction so the
 * compliance trail captures every state advance — we never want a
 * "user started recording" or "audio uploaded" event that isn't
 * paired with the corresponding state move.
 */

export class SessionAdvanceError extends Error {
  readonly status = 409;
  readonly code = "session_state_conflict";
  constructor(
    readonly sessionId: string,
    readonly expected: InterviewSessionState,
    readonly to: InterviewSessionState,
  ) {
    super(
      `Cannot advance session ${sessionId} from "${expected}" to "${to}": ` +
        "current state is something else (concurrent update or wrong session).",
    );
    this.name = "SessionAdvanceError";
  }
}

/**
 * Raised when the audio_files UNIQUE(session_id) constraint fires —
 * i.e. some other code path already inserted a row for this session.
 * Mapped to 409 by the route so the client doesn't see a generic 500
 * for what is, semantically, a state conflict.
 */
export class DuplicateAudioFileError extends Error {
  readonly status = 409;
  readonly code = "audio_already_uploaded";
  constructor(readonly sessionId: string) {
    super(`Audio file already exists for session ${sessionId}.`);
    this.name = "DuplicateAudioFileError";
  }
}

/**
 * Optional request-context metadata. We thread these through every
 * audit-log write so a future compliance review can attribute the
 * action to the IP/UA the user was on at the time. The route is
 * always the source — passing them in keeps this module
 * request-context-free (it doesn't import `next/headers`).
 */
interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Postgres unique-constraint violations bubble out of `pg` with the
 * SQLSTATE `"23505"` on the error object. Drizzle wraps the error but
 * keeps the original on the `cause` chain. We walk that chain so the
 * detection works regardless of how many wrappers Drizzle adds.
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur; i++) {
    if (typeof cur === "object" && cur !== null) {
      const code = (cur as { code?: unknown }).code;
      if (code === "23505") return true;
      cur = (cur as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

/**
 * Atomically move `created → recording` for a session owned by
 * `userId`, AND write a `session.recording.started` audit row in the
 * same transaction. Returns the updated row, or throws
 * `SessionAdvanceError` if the row isn't in `created` (concurrent
 * advance, ownership mismatch, or soft-deleted). Ownership is
 * enforced inside the WHERE clause so a forged session id never
 * escalates into a write.
 */
export async function startRecording(
  args: { sessionId: string; userId: string } & RequestMeta,
): Promise<InterviewSession> {
  assertTransitionAllowed("created", "recording");

  return db.transaction(async (tx) => {
    // Defense-in-depth: `state = 'created'` already implies "not
    // soft-deleted" under the current state machine (delete sets
    // state = 'deleted'), but adding `deleted_at IS NULL` keeps a
    // future code path that ever soft-deletes without changing
    // state from being silently re-armed for recording.
    const [row] = await tx
      .update(schema.interviewSessions)
      .set({ state: "recording", updatedAt: new Date() })
      .where(
        and(
          eq(schema.interviewSessions.id, args.sessionId),
          eq(schema.interviewSessions.userId, args.userId),
          eq(schema.interviewSessions.state, "created"),
          isNull(schema.interviewSessions.deletedAt),
        ),
      )
      .returning();

    if (!row) {
      throw new SessionAdvanceError(args.sessionId, "created", "recording");
    }

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "session.recording.started",
      eventData: {
        sessionId: args.sessionId,
      },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });

    return row;
  });
}

/**
 * Compensating UPDATE used when an upload-url token generation fails AFTER
 * `startRecording` has already moved the row to `recording`. We
 * roll the row back to `created` and write a paired audit event so
 * the lifecycle stays auditable.
 *
 * Returns `true` if a row was rolled back, `false` if the state had
 * already advanced past `recording` by the time we got here (the
 * token generation failure case is rare; this guard means a concurrent
 * `/uploaded` finalize wouldn't be silently undone).
 */
export async function rollbackRecordingStart(
  args: { sessionId: string; userId: string } & RequestMeta,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.interviewSessions)
      .set({ state: "created", updatedAt: new Date() })
      .where(
        and(
          eq(schema.interviewSessions.id, args.sessionId),
          eq(schema.interviewSessions.userId, args.userId),
          eq(schema.interviewSessions.state, "recording"),
          isNull(schema.interviewSessions.deletedAt),
        ),
      )
      .returning({ id: schema.interviewSessions.id });

    if (!row) return false;

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "session.recording.start_rolled_back",
      eventData: {
        sessionId: args.sessionId,
        reason: "presign_failed",
      },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });

    return true;
  });
}

/**
 * Atomically move `recording → transcribing` AND insert the
 * `audio_files` row inside one transaction. If the state guard fails
 * we roll back so we don't end up with an audio_files row pointing
 * at a session that's already in some other state.
 *
 * `scheduledDeletionAt` defaults to one hour from now (per spec) but
 * is exposed as an arg so tests can pin it deterministically.
 *
 * Throws `DuplicateAudioFileError` (mapped to 409 by the caller) if
 * the audio_files UNIQUE(session_id) constraint fires — defense in
 * depth on top of the state guard, since a future code path could
 * theoretically race the guard.
 */
export async function finalizeUpload(
  args: {
    sessionId: string;
    userId: string;
    s3Key: string;
    fileSizeBytes: number;
    durationSeconds: number;
    scheduledDeletionAt?: Date;
  } & RequestMeta,
): Promise<{ session: InterviewSession; audioFile: AudioFile }> {
  assertTransitionAllowed("recording", "transcribing");

  const scheduledDeletionAt =
    args.scheduledDeletionAt ?? new Date(Date.now() + 60 * 60 * 1000);

  try {
    return await db.transaction(async (tx) => {
      const [session] = await tx
        .update(schema.interviewSessions)
        .set({ state: "transcribing", updatedAt: new Date() })
        .where(
          and(
            eq(schema.interviewSessions.id, args.sessionId),
            eq(schema.interviewSessions.userId, args.userId),
            eq(schema.interviewSessions.state, "recording"),
            isNull(schema.interviewSessions.deletedAt),
          ),
        )
        .returning();

      if (!session) {
        // Throwing rolls the transaction back. Both the audio_files
        // insert AND the state bump are abandoned together — no
        // dangling pointer to a session that didn't transition.
        throw new SessionAdvanceError(
          args.sessionId,
          "recording",
          "transcribing",
        );
      }

      const [audioFile] = await tx
        .insert(schema.audioFiles)
        .values({
          sessionId: args.sessionId,
          s3Key: args.s3Key,
          fileSizeBytes: args.fileSizeBytes,
          durationSeconds: args.durationSeconds,
          scheduledDeletionAt,
        })
        .returning();

      if (!audioFile) {
        throw new Error(
          `finalizeUpload: audio_files INSERT returned no row (session ${args.sessionId})`,
        );
      }

      await tx.insert(schema.auditLog).values({
        userId: args.userId,
        eventType: "session.audio.uploaded",
        eventData: {
          sessionId: args.sessionId,
          audioFileId: audioFile.id,
          s3Key: args.s3Key,
          fileSizeBytes: args.fileSizeBytes,
          durationSeconds: args.durationSeconds,
        },
        ipAddress: args.ipAddress ?? null,
        userAgent: args.userAgent ?? null,
      });

      return { session, audioFile };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DuplicateAudioFileError(args.sessionId);
    }
    throw err;
  }
}
