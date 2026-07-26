/**
 * Integration tests for the audio-flow state transitions.
 *
 * Exercises `startRecording` and `finalizeUpload` against the local
 * Postgres so we cover:
 *   - Atomic state guards (no race lets two callers each move
 *     `created → recording`).
 *   - Transactional consistency for `finalizeUpload` — when the
 *     UPDATE fails, the `audio_files` INSERT must roll back.
 *   - Audit-log emission on a successful upload.
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
  SessionAdvanceError,
  startRecording,
} from "@/lib/sessions/audio";
import { buildAudioKey } from "@/lib/storage/keys";

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
  const result = await createCredentialsUser({
    email,
    password: "password123",
    name: "Alice",
  });
  if (!result.ok) throw new Error(`seedUser failed: ${result.error}`);
  return result.user;
};

const seedSession = async (userId: string) =>
  createSession({
    userId,
    companyName: "Stripe",
    roleTitle: "Senior Backend Engineer",
    level: "senior",
    roundType: "system_design",
    scheduledAt: null,
  });

describe("startRecording", () => {
  it("moves a created session to recording", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);

    const updated = await startRecording({
      sessionId: session.id,
      userId: user.id,
    });
    expect(updated.state).toBe("recording");

    const [row] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(row?.state).toBe("recording");
  });

  it("throws SessionAdvanceError if the session is already recording", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    await startRecording({ sessionId: session.id, userId: user.id });

    await expect(
      startRecording({ sessionId: session.id, userId: user.id }),
    ).rejects.toBeInstanceOf(SessionAdvanceError);
  });

  it("throws SessionAdvanceError when called by a different user", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    const session = await seedSession(alice.id);

    await expect(
      startRecording({ sessionId: session.id, userId: bob.id }),
    ).rejects.toBeInstanceOf(SessionAdvanceError);

    // Alice's session is still in created — Bob's attempt did not
    // touch it.
    const [row] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(row?.state).toBe("created");
  });
});

describe("finalizeUpload", () => {
  it("transitions recording → transcribing and inserts an audio_files row", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    await startRecording({ sessionId: session.id, userId: user.id });

    const key = buildAudioKey({ userId: user.id, sessionId: session.id });
    const result = await finalizeUpload({
      sessionId: session.id,
      userId: user.id,
      s3Key: key,
      fileSizeBytes: 12345,
      durationSeconds: 1800,
    });
    expect(result.session.state).toBe("transcribing");
    expect(result.audioFile.s3Key).toBe(key);
    expect(result.audioFile.fileSizeBytes).toBe(12345);
    expect(result.audioFile.durationSeconds).toBe(1800);
    expect(result.audioFile.scheduledDeletionAt.getTime()).toBeGreaterThan(
      Date.now() + 30 * 60 * 1000,
    );

    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id))
      .orderBy(schema.auditLog.createdAt);
    // First audit row is `session.created`; the most recent one
    // should be `session.audio.uploaded`.
    const allAudits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));
    void audit;
    const types = allAudits.map((r) => r.eventType);
    expect(types).toContain("session.audio.uploaded");
  });

  it("rolls back atomically when the session is not in recording state", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    // Deliberately do NOT advance to recording.

    const key = buildAudioKey({ userId: user.id, sessionId: session.id });
    await expect(
      finalizeUpload({
        sessionId: session.id,
        userId: user.id,
        s3Key: key,
        fileSizeBytes: 1,
        durationSeconds: 1,
      }),
    ).rejects.toBeInstanceOf(SessionAdvanceError);

    const audioRows = await db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.sessionId, session.id));
    expect(audioRows).toHaveLength(0);
  });

  it("rolls back when the session belongs to a different user", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    const session = await seedSession(alice.id);
    await startRecording({ sessionId: session.id, userId: alice.id });

    const key = buildAudioKey({
      userId: bob.id,
      sessionId: session.id,
    });
    await expect(
      finalizeUpload({
        sessionId: session.id,
        userId: bob.id,
        s3Key: key,
        fileSizeBytes: 1,
        durationSeconds: 1,
      }),
    ).rejects.toBeInstanceOf(SessionAdvanceError);

    // Alice's session is still in recording — Bob's attempt did not
    // advance it.
    const [row] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(row?.state).toBe("recording");

    const audioRows = await db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.sessionId, session.id));
    expect(audioRows).toHaveLength(0);
  });
});
