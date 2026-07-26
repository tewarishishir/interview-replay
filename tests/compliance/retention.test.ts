/**
 * Tests for the session-retention helpers.
 *
 * Policy (updated): `enforceSessionRetention` only cleans up audio
 * files — transcripts, artifacts, outcomes, reports, and the session
 * row itself are NEVER touched by the retention cron. Data lives until
 * the user deletes their account.
 *
 * local storage is not configured in the test env, so `deleteAudioObject` throws
 * `local storageNotConfiguredError`, which `enforceSessionRetention` swallows
 * intentionally — that path is what we exercise here. The local storage happy
 * path is covered separately by the audio-routes integration tests.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import {
  enforceSessionRetention,
  findRetentionExpiredSessions,
  Retentionlocal storageCleanupError,
} from "@/lib/compliance";
import * as s3Delete from "@/lib/storage/delete";
import { local storageNotConfiguredError } from "@/lib/storage";

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

const insertUser = async (email = "alice@example.com") => {
  const [user] = await db
    .insert(schema.users)
    .values({
      email,
      name: "Alice Example",
      passwordHash: "fake-argon2-hash",
    })
    .returning();
  if (!user) throw new Error("insertUser: no row returned");
  return user;
};

const insertSession = async (
  userId: string,
  retentionUntil: Date = new Date(Date.now() + 30 * 86_400_000),
) => {
  const [session] = await db
    .insert(schema.interviewSessions)
    .values({
      userId,
      companyName: "Acme",
      roleTitle: "Engineer",
      level: "senior",
      roundType: "coding",
      consentAffirmedAt: new Date(),
      retentionUntil,
    })
    .returning();
  if (!session) throw new Error("insertSession: no row returned");
  return session;
};

describe("findRetentionExpiredSessions", () => {
  it("returns sessions whose retention_until is in the past and not soft-deleted", async () => {
    const user = await insertUser();
    const past = await insertSession(
      user.id,
      new Date(Date.now() - 60 * 60_000),
    );
    const future = await insertSession(
      user.id,
      new Date(Date.now() + 60 * 60_000),
    );

    const expired = await findRetentionExpiredSessions();
    const ids = expired.map((r) => r.sessionId);
    expect(ids).toContain(past.id);
    expect(ids).not.toContain(future.id);
  });

  it("ignores sessions already soft-deleted", async () => {
    const user = await insertUser();
    const past = await insertSession(
      user.id,
      new Date(Date.now() - 60 * 60_000),
    );
    await db
      .update(schema.interviewSessions)
      .set({ deletedAt: new Date(), state: "deleted" })
      .where(eq(schema.interviewSessions.id, past.id));

    const expired = await findRetentionExpiredSessions();
    expect(expired.map((r) => r.sessionId)).not.toContain(past.id);
  });
});

describe("enforceSessionRetention", () => {
  it("keeps transcripts, artifacts, reports, and the session — only audio is eligible for cleanup", async () => {
    const user = await insertUser();
    const session = await insertSession(
      user.id,
      new Date(Date.now() - 60 * 60_000),
    );

    await db.insert(schema.transcripts).values({
      sessionId: session.id,
      rawText: "hello",
      redactedText: "hello",
      wordCount: 1,
      durationSeconds: 5,
      fillerWordCount: 0,
    });
    await db.insert(schema.artifacts).values({
      sessionId: session.id,
      artifactType: "code",
      content: "int main(){}",
    });
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { score: 4 },
      modelVersion: "v1",
      rubricVersion: "r1",
    });

    const result = await enforceSessionRetention({
      sessionId: session.id,
      userId: user.id,
    });

    // No audio files → nothing to clean up.
    expect(result.audioKeysAttempted).toHaveLength(0);
    expect(result.audioRowsMarkedDeleted).toBe(0);

    // Transcripts, artifacts, and reports are all preserved.
    const remainingTranscripts = await db
      .select()
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, session.id));
    expect(remainingTranscripts).toHaveLength(1);

    const remainingArtifacts = await db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.sessionId, session.id));
    expect(remainingArtifacts).toHaveLength(1);

    const remainingReports = await db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, session.id));
    expect(remainingReports).toHaveLength(1);

    // Session is NOT soft-deleted.
    const [sessionRow] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(sessionRow?.deletedAt).toBeNull();
    expect(sessionRow?.state).not.toBe("deleted");
  });

  it("marks audio_files rows deleted (local storage unconfigured is tolerated)", async () => {
    const user = await insertUser();
    const session = await insertSession(
      user.id,
      new Date(Date.now() - 60 * 60_000),
    );
    await db.insert(schema.audioFiles).values({
      sessionId: session.id,
      s3Key: "sessions/u/abc.webm",
      fileSizeBytes: 1024,
      durationSeconds: 30,
      scheduledDeletionAt: new Date(Date.now() + 60_000),
    });

    // Mock the local storage delete as "not configured" so this test is hermetic
    // regardless of whether the test env has local storage credentials set.
    const spy = vi
      .spyOn(s3Delete, "deleteAudioObject")
      .mockRejectedValueOnce(new local storageNotConfiguredError());

    const result = await enforceSessionRetention({
      sessionId: session.id,
      userId: user.id,
    });

    spy.mockRestore();

    expect(result.audioKeysAttempted).toEqual(["sessions/u/abc.webm"]);
    expect(result.audioRowsMarkedDeleted).toBe(1);

    const [audio] = await db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.sessionId, session.id));
    expect(audio?.deletedAt).toBeInstanceOf(Date);
  });

  describe("local storage failure handling", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("throws Retentionlocal storageCleanupError and leaves the audio_files row UNDELETED when local storage fails", async () => {
      const user = await insertUser();
      const session = await insertSession(
        user.id,
        new Date(Date.now() - 60 * 60_000),
      );
      await db.insert(schema.audioFiles).values({
        sessionId: session.id,
        s3Key: "sessions/u/will-fail.webm",
        fileSizeBytes: 1024,
        durationSeconds: 30,
        scheduledDeletionAt: new Date(Date.now() + 60_000),
      });

      // Simulate a real local storage failure (network blip, AccessDenied, etc.)
      // Critically NOT an local storageNotConfiguredError — those are tolerated.
      const spy = vi
        .spyOn(s3Delete, "deleteAudioObject")
        .mockRejectedValueOnce(new Error("AccessDenied"));

      await expect(
        enforceSessionRetention({
          sessionId: session.id,
          userId: user.id,
        }),
      ).rejects.toBeInstanceOf(Retentionlocal storageCleanupError);

      expect(spy).toHaveBeenCalledTimes(1);

      // The whole point of the fix: the audio_files row MUST stay
      // visible to the SLA sweeper. If it had been marked deleted,
      // the orphan in local storage would never be retried.
      const [audio] = await db
        .select()
        .from(schema.audioFiles)
        .where(eq(schema.audioFiles.sessionId, session.id));
      expect(audio?.deletedAt).toBeNull();

      // The session itself stays alive too, so tomorrow's retention
      // cron will pick it up again and retry end-to-end.
      const [sessionRow] = await db
        .select()
        .from(schema.interviewSessions)
        .where(eq(schema.interviewSessions.id, session.id));
      expect(sessionRow?.deletedAt).toBeNull();
      expect(sessionRow?.state).not.toBe("deleted");
    });
  });

  it("keeps session_outcomes — outcomes are never deleted by the retention cron", async () => {
    const user = await insertUser();
    const session = await insertSession(
      user.id,
      new Date(Date.now() - 60 * 60_000),
    );
    await db.insert(schema.sessionOutcomes).values({
      sessionId: session.id,
      outcomeType: "received_offer",
      feedbackReceived: "Sensitive feedback preserved indefinitely",
      reflectionNotes: "I was nervous about the design question",
      wouldChange: "Push back earlier on assumptions",
    });

    await enforceSessionRetention({
      sessionId: session.id,
      userId: user.id,
    });

    const remaining = await db
      .select()
      .from(schema.sessionOutcomes)
      .where(eq(schema.sessionOutcomes.sessionId, session.id));
    expect(remaining).toHaveLength(1);
  });

  it("writes an audio.deleted audit row for each audio file cleaned up", async () => {
    const user = await insertUser();
    const session = await insertSession(
      user.id,
      new Date(Date.now() - 60 * 60_000),
    );
    await db.insert(schema.audioFiles).values({
      sessionId: session.id,
      s3Key: "sessions/u/audit-test.webm",
      fileSizeBytes: 512,
      durationSeconds: 10,
      scheduledDeletionAt: new Date(Date.now() + 60_000),
    });

    const spy = vi
      .spyOn(s3Delete, "deleteAudioObject")
      .mockRejectedValueOnce(new local storageNotConfiguredError());

    await enforceSessionRetention({
      sessionId: session.id,
      userId: user.id,
    });

    spy.mockRestore();

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));

    const audioDeleted = audit.find((a) => a.eventType === "audio.deleted");
    expect(audioDeleted).toBeDefined();
  });
});
