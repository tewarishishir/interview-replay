/**
 * Integration tests for the transcribe-session orchestration helpers
 * + the SLA cron's read-side queries + audio deletion.
 *
 * What we cover here:
 *   - `loadAudioForTranscription` flips `transcription_started_at`.
 *   - `persistTranscriptAndAdvance` writes the transcript, advances
 *     the session to `review`, and stamps an audit row.
 *   - The "transcription failure" branch still writes a transcripts
 *     row (with `transcription_error`) and still advances the session
 *     to `review` — this is the "ALWAYS schedule audio deletion
 *     regardless of transcription success" rule from the spec.
 *   - `markScheduledDeletion` sets `scheduled_deletion_at` to the
 *     `now() + 60s` window the spec requires.
 *   - `recordAudioDeletion` is idempotent (a re-run after the row is
 *     already deleted is a no-op, no duplicate audit row).
 *   - `findOverdueAudioFiles` and `countSlaBreaches` both honor the
 *     `deleted_at IS NULL` filter and the time window.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";
import {
  finalizeUpload,
  startRecording,
} from "@/lib/sessions/audio";
import { buildAudioKey } from "@/lib/storage/keys";
import { type ProcessedTranscript } from "@/lib/whisper/process";
import {
  AudioFileNotFoundError,
  detectClippedRecording,
  loadAudioForTranscription,
  markScheduledDeletion,
  persistTranscriptAndAdvance,
  recordAudioDeletion,
} from "@/lib/sessions/transcribe";
import {
  countSlaBreaches,
  findOverdueAudioFiles,
} from "@/lib/sessions/sla";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

const seedUser = async (email = "alice@example.com") => {
  const r = await createCredentialsUser({
    email,
    password: "password123",
    name: "Alice",
  });
  if (!r.ok) throw new Error(`seedUser failed: ${r.error}`);
  return r.user;
};

interface Seeded {
  userId: string;
  sessionId: string;
  audioFileId: string;
  s3Key: string;
}

const seedReadyForTranscription = async (
  email = "alice@example.com",
): Promise<Seeded> => {
  const user = await seedUser(email);
  const session = await createSession({
    userId: user.id,
    companyName: "Stripe",
    roleTitle: "Senior Backend Engineer",
    level: "senior",
    roundType: "system_design",
    scheduledAt: null,
  });
  await startRecording({ sessionId: session.id, userId: user.id });
  const key = buildAudioKey({ userId: user.id, sessionId: session.id });
  const r = await finalizeUpload({
    sessionId: session.id,
    userId: user.id,
    s3Key: key,
    fileSizeBytes: 100_000,
    durationSeconds: 600,
  });
  return {
    userId: user.id,
    sessionId: session.id,
    audioFileId: r.audioFile.id,
    s3Key: key,
  };
};

describe("loadAudioForTranscription", () => {
  it("returns the row and stamps transcription_started_at", async () => {
    const seed = await seedReadyForTranscription();
    const before = new Date();
    const row = await loadAudioForTranscription(seed.audioFileId);
    expect(row.id).toBe(seed.audioFileId);
    expect(row.s3Key).toBe(seed.s3Key);
    expect(row.sessionId).toBe(seed.sessionId);

    const [persisted] = await db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.id, seed.audioFileId));
    expect(persisted?.transcriptionStartedAt).not.toBeNull();
    expect(persisted!.transcriptionStartedAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
  });

  it("throws AudioFileNotFoundError for a row that doesn't exist", async () => {
    await expect(
      loadAudioForTranscription("00000000-0000-0000-0000-000000000000"),
    ).rejects.toBeInstanceOf(AudioFileNotFoundError);
  });
});

describe("persistTranscriptAndAdvance — AI-inferred artifacts", () => {
  it("stores high, medium, AND low confidence inferences as artifacts with source='ai_inferred'", async () => {
    const seed = await seedReadyForTranscription();

    const processed: ProcessedTranscript = {
      audioDurationSeconds: 120,
      rawText: "raw",
      redactedText: "redacted",
      redactionCount: 0,
      candidateSpeaker: 0,
      candidateWordCount: 1,
      candidateFillerWordCount: 0,
    };

    await persistTranscriptAndAdvance({
      sessionId: seed.sessionId,
      audioFileId: seed.audioFileId,
      durationSeconds: 120,
      processed,
      transcriptionError: null,
      userId: seed.userId,
      // ALL three confidence bands are persisted and surfaced to
      // the candidate as suggestion cards. Each card displays its
      // band so the candidate can decide whether to confirm or
      // dismiss — we don't filter at the persistence boundary.
      inferredQuestions: [
        {
          inferred_question: "Tell me about yourself.",
          confidence: "high",
          transcript_offset: 0,
          transcript_length: 50,
        },
        {
          inferred_question: "Why this company?",
          confidence: "medium",
          transcript_offset: 100,
          transcript_length: 80,
        },
        {
          inferred_question: "Maybe a question about scaling?",
          confidence: "low",
          transcript_offset: 200,
          transcript_length: 60,
        },
      ],
    });

    const rows = await db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.sessionId, seed.sessionId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.source).toBe("ai_inferred");
      expect(row.artifactType).toBe("question");
      expect(row.userConfirmedAt).toBeNull();
      expect(row.dismissedAt).toBeNull();
    }
    const high = rows.find((r) => r.aiConfidence === "high");
    const medium = rows.find((r) => r.aiConfidence === "medium");
    const low = rows.find((r) => r.aiConfidence === "low");
    expect(high?.content).toBe("Tell me about yourself.");
    expect(high?.linkedTranscriptOffset).toBe(0);
    expect(high?.linkedTranscriptLength).toBe(50);
    expect(medium?.content).toBe("Why this company?");
    expect(medium?.linkedTranscriptOffset).toBe(100);
    expect(low?.content).toBe("Maybe a question about scaling?");
    expect(low?.linkedTranscriptOffset).toBe(200);

    // Audit row carries the count so a forensic review can quickly
    // tell whether the inference pass actually fired.
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, seed.userId));
    const completed = audits.find(
      (r) => r.eventType === "session.transcription.completed",
    );
    expect(
      (completed?.eventData as Record<string, unknown>)?.inferredQuestionCount,
    ).toBe(3);
  });

  it("writes ZERO artifacts when the transcript itself failed (transcription_error set)", async () => {
    const seed = await seedReadyForTranscription();

    // Even if the inference pass somehow returned items (it shouldn't,
    // because the transcript is empty), the persist helper refuses
    // to attach phantom AI cards to a session whose transcript
    // failed — that would make the review screen even more
    // confusing.
    await persistTranscriptAndAdvance({
      sessionId: seed.sessionId,
      audioFileId: seed.audioFileId,
      durationSeconds: 0,
      processed: null,
      transcriptionError: "transcription serviceError: timeout",
      userId: seed.userId,
      inferredQuestions: [
        {
          inferred_question: "should not be persisted",
          confidence: "high",
          transcript_offset: 0,
          transcript_length: 5,
        },
      ],
    });

    const rows = await db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.sessionId, seed.sessionId));
    expect(rows).toHaveLength(0);
  });

  it("falls back to zero inferences when the worker passes an empty array", async () => {
    const seed = await seedReadyForTranscription();

    const processed: ProcessedTranscript = {
      audioDurationSeconds: 60,
      rawText: "x",
      redactedText: "x",
      redactionCount: 0,
      candidateSpeaker: 0,
      candidateWordCount: 1,
      candidateFillerWordCount: 0,
    };

    await persistTranscriptAndAdvance({
      sessionId: seed.sessionId,
      audioFileId: seed.audioFileId,
      durationSeconds: 60,
      processed,
      transcriptionError: null,
      userId: seed.userId,
      inferredQuestions: [],
    });

    const rows = await db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.sessionId, seed.sessionId));
    expect(rows).toHaveLength(0);
  });
});

describe("persistTranscriptAndAdvance — happy path", () => {
  it("writes the transcript, advances to review, and audits", async () => {
    const seed = await seedReadyForTranscription();

    const processed: ProcessedTranscript = {
      audioDurationSeconds: 605,
      rawText: "raw text from transcription",
      redactedText: "redacted text",
      redactionCount: 2,
      candidateSpeaker: 0,
      candidateWordCount: 3,
      candidateFillerWordCount: 1,
    };

    const { transcriptId } = await persistTranscriptAndAdvance({
      sessionId: seed.sessionId,
      audioFileId: seed.audioFileId,
      durationSeconds: 600,
      processed,
      transcriptionError: null,
      userId: seed.userId,
    });
    expect(transcriptId).toBeTruthy();

    const [t] = await db
      .select()
      .from(schema.transcripts)
      .where(eq(schema.transcripts.id, transcriptId));
    expect(t?.redactedText).toBe("redacted text");
    expect(t?.redactionCount).toBe(2);
    expect(t?.fillerWordCount).toBe(1);
    expect(t?.transcriptionError).toBeNull();
    // C1: persisted duration must come from transcription service (605s), NOT
    // from the client-reported `durationSeconds` (600s).
    expect(t?.durationSeconds).toBe(605);

    const [s] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, seed.sessionId));
    expect(s?.state).toBe("review");

    const [a] = await db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.id, seed.audioFileId));
    expect(a?.transcriptionCompletedAt).not.toBeNull();
    // C1: audio_files.duration_seconds gets rewritten to the
    // transcription service-derived value as well, so the two columns can't drift.
    expect(a?.durationSeconds).toBe(605);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, seed.userId));
    const types = audits.map((r) => r.eventType);
    expect(types).toContain("session.transcription.completed");
  });
});

describe("persistTranscriptAndAdvance — idempotency", () => {
  it("returns the existing transcript id on a repeated call (no duplicate, no failure)", async () => {
    const seed = await seedReadyForTranscription();

    const processed: ProcessedTranscript = {
      audioDurationSeconds: 60,
      rawText: "raw",
      redactedText: "red",
      redactionCount: 0,
      candidateSpeaker: 0,
      candidateWordCount: 1,
      candidateFillerWordCount: 0,
    };

    const first = await persistTranscriptAndAdvance({
      sessionId: seed.sessionId,
      audioFileId: seed.audioFileId,
      durationSeconds: 60,
      processed,
      transcriptionError: null,
      userId: seed.userId,
    });

    // Simulate job runner re-firing the function after a lost ack: the
    // session is already in `review`, the transcript already exists,
    // and a naive INSERT would explode on unique(session_id). The
    // helper MUST short-circuit and return the same id.
    const second = await persistTranscriptAndAdvance({
      sessionId: seed.sessionId,
      audioFileId: seed.audioFileId,
      durationSeconds: 60,
      processed,
      transcriptionError: null,
      userId: seed.userId,
    });

    expect(second.transcriptId).toBe(first.transcriptId);

    const all = await db
      .select()
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, seed.sessionId));
    expect(all).toHaveLength(1);

    // Audit row count should also stay at one — no duplicate
    // "session.transcription.completed" entry from the second call.
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, seed.userId));
    const completed = audits.filter(
      (r) => r.eventType === "session.transcription.completed",
    );
    expect(completed).toHaveLength(1);
  });
});

// C1: a malicious / buggy client could try to under-report the
// audio length to dodge billing. The transcription service-derived value MUST
// override the client value at persist time.
describe("persistTranscriptAndAdvance — duration sourcing (C1)", () => {
  it("client says 30s, transcription service says 1800s — we persist 1800s", async () => {
    const seed = await seedReadyForTranscription();

    const processed: ProcessedTranscript = {
      audioDurationSeconds: 1800,
      rawText: "long",
      redactedText: "long",
      redactionCount: 0,
      candidateSpeaker: 0,
      candidateWordCount: 1,
      candidateFillerWordCount: 0,
    };

    await persistTranscriptAndAdvance({
      sessionId: seed.sessionId,
      audioFileId: seed.audioFileId,
      // Lying client: claims this is a 30s recording.
      durationSeconds: 30,
      processed,
      transcriptionError: null,
      userId: seed.userId,
    });

    const [t] = await db
      .select({ durationSeconds: schema.transcripts.durationSeconds })
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, seed.sessionId));
    expect(t?.durationSeconds).toBe(1800);

    const [a] = await db
      .select({ durationSeconds: schema.audioFiles.durationSeconds })
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.id, seed.audioFileId));
    expect(a?.durationSeconds).toBe(1800);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, seed.userId));
    const completed = audits.find(
      (r) => r.eventType === "session.transcription.completed",
    );
    expect(completed).toBeDefined();
    // The audit row captures the discrepancy so a forensic review
    // can spot tampering.
    const eventData = completed?.eventData as Record<string, unknown>;
    expect(eventData?.clientReportedDurationSeconds).toBe(30);
    expect(eventData?.durationSeconds).toBe(1800);
  });

  it("transcription service returns no duration — falls back to the client value", async () => {
    const seed = await seedReadyForTranscription();

    const processed: ProcessedTranscript = {
      audioDurationSeconds: null,
      rawText: "x",
      redactedText: "x",
      redactionCount: 0,
      candidateSpeaker: 0,
      candidateWordCount: 1,
      candidateFillerWordCount: 0,
    };

    await persistTranscriptAndAdvance({
      sessionId: seed.sessionId,
      audioFileId: seed.audioFileId,
      durationSeconds: 90,
      processed,
      transcriptionError: null,
      userId: seed.userId,
    });

    const [t] = await db
      .select({ durationSeconds: schema.transcripts.durationSeconds })
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, seed.sessionId));
    expect(t?.durationSeconds).toBe(90);
  });
});

describe("persistTranscriptAndAdvance — failure branch", () => {
  it("writes a transcripts row with transcription_error and still advances to review", async () => {
    const seed = await seedReadyForTranscription();

    await persistTranscriptAndAdvance({
      sessionId: seed.sessionId,
      audioFileId: seed.audioFileId,
      durationSeconds: 0,
      processed: null,
      transcriptionError: "transcription serviceError: timeout after 3 attempts",
      userId: seed.userId,
    });

    const [t] = await db
      .select()
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, seed.sessionId));
    expect(t?.transcriptionError).toMatch(/transcription serviceError/);
    expect(t?.redactedText).toBe("");
    expect(t?.redactionCount).toBe(0);

    const [s] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, seed.sessionId));
    // Spec: "After final failure, mark session 'review' with empty
    // transcript and a transcription_error flag in transcripts table".
    expect(s?.state).toBe("review");

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, seed.userId));
    const types = audits.map((r) => r.eventType);
    expect(types).toContain("session.transcription.failed");
  });
});

describe("markScheduledDeletion", () => {
  it("schedules deletion ~60 seconds from now", async () => {
    const seed = await seedReadyForTranscription();
    const before = Date.now();
    const at = await markScheduledDeletion(seed.audioFileId, 60);
    const after = Date.now();
    // Within a few seconds of `now + 60s`.
    expect(at.getTime()).toBeGreaterThanOrEqual(before + 60_000 - 5_000);
    expect(at.getTime()).toBeLessThanOrEqual(after + 60_000 + 5_000);

    const [a] = await db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.id, seed.audioFileId));
    expect(a?.scheduledDeletionAt.getTime()).toBe(at.getTime());
  });
});

describe("recordAudioDeletion — idempotency", () => {
  it("marks the row deleted and emits ONE audit row", async () => {
    const seed = await seedReadyForTranscription();

    const first = await recordAudioDeletion({
      audioFileId: seed.audioFileId,
      userId: seed.userId,
      s3Key: seed.s3Key,
      reason: "scheduled",
    });
    expect(first).toBe(true);

    const second = await recordAudioDeletion({
      audioFileId: seed.audioFileId,
      userId: seed.userId,
      s3Key: seed.s3Key,
      reason: "scheduled",
    });
    expect(second).toBe(false);

    const [a] = await db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.id, seed.audioFileId));
    expect(a?.deletedAt).not.toBeNull();

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, seed.userId));
    const audioDeletedRows = audits.filter(
      (r) => r.eventType === "audio.deleted",
    );
    expect(audioDeletedRows).toHaveLength(1);
  });
});

describe("SLA queries", () => {
  it("findOverdueAudioFiles returns rows past their scheduled deletion that aren't already deleted", async () => {
    const overdue = await seedReadyForTranscription("alice@example.com");
    const fresh = await seedReadyForTranscription("bob@example.com");
    const alreadyGone = await seedReadyForTranscription("carol@example.com");

    // Overdue: backdate deletion to 2 minutes ago.
    await db
      .update(schema.audioFiles)
      .set({ scheduledDeletionAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(schema.audioFiles.id, overdue.audioFileId));

    // Fresh: leave the default ~30 days out (set by finalizeUpload).
    void fresh;

    // Already deleted: also overdue, but deleted_at is set so the
    // query must skip it.
    await db
      .update(schema.audioFiles)
      .set({
        scheduledDeletionAt: new Date(Date.now() - 2 * 60_000),
        deletedAt: new Date(),
      })
      .where(eq(schema.audioFiles.id, alreadyGone.audioFileId));

    const rows = await findOverdueAudioFiles();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(overdue.audioFileId);
    expect(ids).not.toContain(fresh.audioFileId);
    expect(ids).not.toContain(alreadyGone.audioFileId);
  });

  it("countSlaBreaches counts rows past now() - 1 hour AND not yet deleted", async () => {
    const breach = await seedReadyForTranscription("alice@example.com");
    const recent = await seedReadyForTranscription("bob@example.com");

    // Breach: 90 minutes past deadline.
    await db
      .update(schema.audioFiles)
      .set({ scheduledDeletionAt: new Date(Date.now() - 90 * 60_000) })
      .where(eq(schema.audioFiles.id, breach.audioFileId));

    // Recent: only 5 minutes past deadline — overdue, NOT a breach.
    await db
      .update(schema.audioFiles)
      .set({ scheduledDeletionAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(schema.audioFiles.id, recent.audioFileId));

    const count = await countSlaBreaches();
    expect(count).toBe(1);
  });
});

describe("detectClippedRecording", () => {
  // Pure helper, no DB access needed. Locks in the heuristic so a
  // future tweak to the threshold can't silently regress.

  it("returns null when transcription service didn't measure the audio", () => {
    expect(
      detectClippedRecording({
        clientReportedSeconds: 200,
        audioDurationSeconds: null,
        candidateWordCount: 0,
      }),
    ).toBeNull();
  });

  it("returns null for genuinely short recordings (<30s client)", () => {
    // 25s timer / 8s audio is suspicious but BELOW the floor — we
    // don't want false positives on snappy short answers.
    expect(
      detectClippedRecording({
        clientReportedSeconds: 25,
        audioDurationSeconds: 8,
        candidateWordCount: 0,
      }),
    ).toBeNull();
  });

  it("returns null when audio length is within tolerance of client", () => {
    // 60s client, 35s audio (>50%) is plausible silence-trim, not
    // a clipped recording.
    expect(
      detectClippedRecording({
        clientReportedSeconds: 60,
        audioDurationSeconds: 35,
        candidateWordCount: 0,
      }),
    ).toBeNull();
  });

  it("returns null when transcription service extracted some words", () => {
    // Even if duration looks clipped, a non-empty transcript means
    // the user has SOMETHING to edit — don't block them with a
    // banner that overrides the transcript.
    expect(
      detectClippedRecording({
        clientReportedSeconds: 200,
        audioDurationSeconds: 8,
        candidateWordCount: 12,
      }),
    ).toBeNull();
  });

  it("flags the failing case from the user report (172s client / 8s audio / 0 words)", () => {
    // Reproduces the exact case that surfaced this bug. If this
    // ever stops returning a banner, the recorder fix has been
    // partially undone or the heuristic changed.
    const banner = detectClippedRecording({
      clientReportedSeconds: 172,
      audioDurationSeconds: 8,
      candidateWordCount: 0,
    });
    expect(banner).not.toBeNull();
    expect(banner).toMatch(/172s/);
    expect(banner).toMatch(/8s/);
    expect(banner).toMatch(/microphone/i);
  });
});
