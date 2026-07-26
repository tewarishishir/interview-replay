/**
 * Integration tests for the audio API routes.
 *
 * - POST /api/sessions/:id/audio/upload-url
 * - POST /api/sessions/:id/audio/uploaded
 * - GET  /api/sessions/:id (the polling endpoint)
 *
 * We mock:
 *   - `next/headers` so we can drive the same-origin guard.
 *   - `@/lib/auth/session.getActiveUserId` to express "active user X"
 *     in one line.
 *   - `@/lib/storage/presign` to avoid reaching out to local storage/MinIO from the
 *     test process. The route's contract with that module (it
 *     returns `{ url, key, expiresAt, requiredHeaders }`) is what
 *     we want to verify, not the storage signing math itself.
 *   - `@/lib/job-runner` so the `uploaded` route's best-effort publish
 *     doesn't hit the dev server when it isn't running.
 *
 * The Drizzle layer hits real Postgres because the state-machine
 * transitions are the most important behavior to keep honest.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";

const DEFAULT_HEADERS = {
  origin: "http://localhost:3000",
  "x-forwarded-for": "203.0.113.42",
  "user-agent": "Mozilla/5.0 (vitest)",
};
let headerOverride: Record<string, string> | null = null;
const setHeaders = (h: Record<string, string> | null) => {
  headerOverride = h;
};

vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerOverride ?? DEFAULT_HEADERS),
}));

const mockGetActiveUserId = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getActiveUserId: () => mockGetActiveUserId(),
}));

const mockPresign = vi.fn();
vi.mock("@/lib/storage/presign", async () => {
  // Keep the real `AUDIO_CONTENT_TYPE` / expiry export so the rest
  // of the tree stays type-clean. We import the actual module via
  // `vi.importActual` (which returns `unknown`) and re-cast to the
  // shape we know it has — the alternative `typeof import(...)` form
  // hits the project's `consistent-type-imports` rule.
  const actual = (await vi.importActual("@/lib/storage/presign")) as {
    presignAudioPut: (...args: unknown[]) => Promise<unknown>;
  };
  return {
    ...actual,
    presignAudioPut: (...args: unknown[]) => mockPresign(...args),
  };
});

const mockEnqueue = vi.fn();
vi.mock("@/lib/job-runner", () => ({
  enqueueTranscribeSession: (...args: unknown[]) => mockEnqueue(...args),
}));

const mockHead = vi.fn();
vi.mock("@/lib/storage/head", () => ({
  headAudioObject: (...args: unknown[]) => mockHead(...args),
}));

// The route's dev fallback dynamically imports `runTranscribeInline`
// when the job runner publish fails. We mock it here so the rollback
// test doesn't depend on whether `TRANSCRIPTION_API_KEY` is set in the
// developer's `.env.local` (and so the test doesn't make a real
// transcription service API call against a fake presigned local storage URL).
const mockRunTranscribeInline = vi.fn();
vi.mock("@/lib/sessions/transcribe-inline", () => ({
  runTranscribeInline: (...args: unknown[]) =>
    mockRunTranscribeInline(...args),
}));

import { POST as uploadUrlRoute } from "@/app/api/sessions/[id]/audio/upload-url/route";
import { POST as uploadedRoute } from "@/app/api/sessions/[id]/audio/uploaded/route";
import { GET as getSessionRoute } from "@/app/api/sessions/[id]/route";
import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";
import { startRecording } from "@/lib/sessions/audio";
import { buildAudioKey } from "@/lib/storage/keys";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  mockGetActiveUserId.mockReset();
  mockPresign.mockReset();
  mockEnqueue.mockReset();
  mockHead.mockReset();
  mockRunTranscribeInline.mockReset();
  // Default: pretend the inline transcription pipeline isn't
  // available. The fallback test below relies on this so the route
  // ends up writing the "TRANSCRIPTION_API_KEY required" friendly error
  // rather than calling transcription service for real.
  mockRunTranscribeInline.mockRejectedValue(
    new Error("inline_disabled_in_test"),
  );
  // Default to "object exists with the size the client claims" so
  // every existing happy-path test that doesn't care about the HEAD
  // logic keeps passing. Tests that exercise the head-check path
  // override this in-line.
  mockHead.mockImplementation(async () => ({
    exists: true,
    contentLength: null,
  }));
  setHeaders(null);
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

const makeRequest = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

const makeContext = (id: string) => ({
  params: Promise.resolve({ id }),
});

const PRESIGN_RESPONSE = (key: string) => ({
  url: `https://example.test/${key}?signed=1`,
  key,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  requiredHeaders: {
    "Content-Type": "audio/webm",
    "x-amz-server-side-encryption": "AES256",
  },
});

/* ------------------------------------------------------------------ */
/*                        upload-url route                            */
/* ------------------------------------------------------------------ */

describe("POST /api/sessions/:id/audio/upload-url", () => {
  it("returns 401 when no session is present", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await uploadUrlRoute(
      makeRequest("/api/sessions/00000000-0000-4000-8000-000000000000/audio/upload-url", {
        method: "POST",
      }),
      makeContext("00000000-0000-4000-8000-000000000000"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when the Origin is foreign", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    mockGetActiveUserId.mockResolvedValue(user.id);
    setHeaders({ origin: "https://evil.example.com" });

    const res = await uploadUrlRoute(
      makeRequest(`/api/sessions/${session.id}/audio/upload-url`, {
        method: "POST",
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when the session belongs to another user", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    const session = await seedSession(alice.id);
    mockGetActiveUserId.mockResolvedValue(bob.id);

    const res = await uploadUrlRoute(
      makeRequest(`/api/sessions/${session.id}/audio/upload-url`, {
        method: "POST",
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when the session is in a non-recoverable state (transcribing)", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    // Advance directly to transcribing so the route returns 409
    // "no longer eligible" without attempting auto-reset.
    await db
      .update(schema.interviewSessions)
      .set({ state: "transcribing" })
      .where(eq(schema.interviewSessions.id, session.id));
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await uploadUrlRoute(
      makeRequest(`/api/sessions/${session.id}/audio/upload-url`, {
        method: "POST",
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("state_conflict");
  });

  it("returns 409 when recording already has a completed audio file", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    await startRecording({ sessionId: session.id, userId: user.id });
    // Simulate a completed upload: insert an audio_files row.
    await db.insert(schema.audioFiles).values({
      sessionId: session.id,
      s3Key: buildAudioKey({ userId: user.id, sessionId: session.id }),
      fileSizeBytes: 1024,
      durationSeconds: 60,
      scheduledDeletionAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await uploadUrlRoute(
      makeRequest(`/api/sessions/${session.id}/audio/upload-url`, {
        method: "POST",
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("state_conflict");
  });

  it("auto-resets recording session and returns fresh presign when no audio file exists", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    await startRecording({ sessionId: session.id, userId: user.id });
    mockGetActiveUserId.mockResolvedValue(user.id);
    mockPresign.mockImplementation(async (args: { key: string }) =>
      PRESIGN_RESPONSE(args.key),
    );

    const res = await uploadUrlRoute(
      makeRequest(`/api/sessions/${session.id}/audio/upload-url`, {
        method: "POST",
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.url).toMatch(/example\.test/);

    // Session must be back in recording after the auto-reset + re-presign.
    const [row] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(row?.state).toBe("recording");
  });

  it("happy path: bumps state to recording and returns presigned URL", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    mockGetActiveUserId.mockResolvedValue(user.id);

    mockPresign.mockImplementation(async (args: { key: string }) =>
      PRESIGN_RESPONSE(args.key),
    );

    const res = await uploadUrlRoute(
      makeRequest(`/api/sessions/${session.id}/audio/upload-url`, {
        method: "POST",
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.url).toMatch(/example\.test/);
    expect(body.key).toMatch(
      new RegExp(`^audio/${user.id}/${session.id}/[0-9a-f-]{36}\\.webm$`),
    );
    expect(body.requiredHeaders["Content-Type"]).toBe("audio/webm");

    const [row] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(row?.state).toBe("recording");
  });

  it("returns 404 for a malformed (non-UUID) session id", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await uploadUrlRoute(
      makeRequest(`/api/sessions/not-a-uuid/audio/upload-url`, {
        method: "POST",
      }),
      makeContext("not-a-uuid"),
    );
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/*                          uploaded route                            */
/* ------------------------------------------------------------------ */

describe("POST /api/sessions/:id/audio/uploaded", () => {
  it("returns 400 when the key is malformed", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    await startRecording({ sessionId: session.id, userId: user.id });
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await uploadedRoute(
      makeRequest(`/api/sessions/${session.id}/audio/uploaded`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: `random-key`,
          file_size_bytes: 1024,
          duration_seconds: 60,
        }),
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_key");
  });

  it("returns 403 when the key encodes a different userId", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    const session = await seedSession(alice.id);
    await startRecording({ sessionId: session.id, userId: alice.id });
    mockGetActiveUserId.mockResolvedValue(alice.id);

    // Alice's session, but the key encodes Bob's userId.
    const forgedKey = buildAudioKey({
      userId: bob.id,
      sessionId: session.id,
    });

    const res = await uploadedRoute(
      makeRequest(`/api/sessions/${session.id}/audio/uploaded`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: forgedKey,
          file_size_bytes: 1024,
          duration_seconds: 60,
        }),
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("key_mismatch");
  });

  it("returns 403 when the key encodes a different sessionId", async () => {
    const user = await seedUser();
    const sessionA = await seedSession(user.id);
    const sessionB = await seedSession(user.id);
    await startRecording({ sessionId: sessionA.id, userId: user.id });
    mockGetActiveUserId.mockResolvedValue(user.id);

    const wrongKey = buildAudioKey({
      userId: user.id,
      sessionId: sessionB.id,
    });

    const res = await uploadedRoute(
      makeRequest(`/api/sessions/${sessionA.id}/audio/uploaded`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: wrongKey,
          file_size_bytes: 1024,
          duration_seconds: 60,
        }),
      }),
      makeContext(sessionA.id),
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 when the session isn't in recording state", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    // Don't advance state.
    mockGetActiveUserId.mockResolvedValue(user.id);

    const key = buildAudioKey({ userId: user.id, sessionId: session.id });
    const res = await uploadedRoute(
      makeRequest(`/api/sessions/${session.id}/audio/uploaded`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          file_size_bytes: 1024,
          duration_seconds: 60,
        }),
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(409);
  });

  it("happy path: writes audio_files, advances to transcribing, and enqueues job runner", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    await startRecording({ sessionId: session.id, userId: user.id });
    mockGetActiveUserId.mockResolvedValue(user.id);
    mockEnqueue.mockResolvedValue(undefined);

    const key = buildAudioKey({ userId: user.id, sessionId: session.id });
    const res = await uploadedRoute(
      makeRequest(`/api/sessions/${session.id}/audio/uploaded`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          file_size_bytes: 12345,
          duration_seconds: 1800,
        }),
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(202);

    const [row] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(row?.state).toBe("transcribing");

    const [audio] = await db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.sessionId, session.id));
    expect(audio?.s3Key).toBe(key);
    expect(audio?.fileSizeBytes).toBe(12345);
    expect(audio?.durationSeconds).toBe(1800);

    expect(mockEnqueue).toHaveBeenCalledWith({
      sessionId: session.id,
      userId: user.id,
      audioFileId: audio?.id,
      s3Key: key,
    });
  });

  it("falls back to advancing the session to review when job runner publish fails in dev (no JOB_RUNNER_EVENT_KEY)", async () => {
    // The vitest setup loads `.env.local`, which does NOT define
    // `JOB_RUNNER_EVENT_KEY` or `TRANSCRIPTION_API_KEY`. The route's dev
    // fallback therefore (a) tries to run the transcription pipeline
    // inline, (b) fails because transcription service isn't configured, and
    // (c) writes a transcript with a `transcriptionError` explaining
    // how to enable auto-transcription. The session unblocks into
    // `review` either way so the candidate isn't stuck on the
    // recorder panel forever.
    const user = await seedUser();
    const session = await seedSession(user.id);
    await startRecording({ sessionId: session.id, userId: user.id });
    mockGetActiveUserId.mockResolvedValue(user.id);
    mockEnqueue.mockRejectedValue(new Error("job-runner down"));

    const key = buildAudioKey({ userId: user.id, sessionId: session.id });
    const res = await uploadedRoute(
      makeRequest(`/api/sessions/${session.id}/audio/uploaded`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          file_size_bytes: 1024,
          duration_seconds: 60,
        }),
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(202);

    const [row] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(row?.state).toBe("review");

    const [transcript] = await db
      .select()
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, session.id));
    expect(transcript?.transcriptionError).toMatch(/TRANSCRIPTION_API_KEY/);
  });
});

/* ------------------------------------------------------------------ */
/*                        GET /api/sessions/:id                       */
/* ------------------------------------------------------------------ */

describe("GET /api/sessions/:id", () => {
  it("returns 401 when no session is present", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await getSessionRoute(
      makeRequest(`/api/sessions/00000000-0000-4000-8000-000000000000`),
      makeContext("00000000-0000-4000-8000-000000000000"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the session is owned by another user", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    const session = await seedSession(alice.id);
    mockGetActiveUserId.mockResolvedValue(bob.id);

    const res = await getSessionRoute(
      makeRequest(`/api/sessions/${session.id}`),
      makeContext(session.id),
    );
    expect(res.status).toBe(404);
  });

  it("returns the session with state for the owner", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await getSessionRoute(
      makeRequest(`/api/sessions/${session.id}`),
      makeContext(session.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toMatchObject({
      id: session.id,
      state: "created",
      companyName: session.companyName,
      roleTitle: session.roleTitle,
    });
  });

  it("sets a no-store Cache-Control header on the response", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await getSessionRoute(
      makeRequest(`/api/sessions/${session.id}`),
      makeContext(session.id),
    );
    expect(res.headers.get("cache-control")).toMatch(/no-store/i);
  });

  it("accepts a same-origin GET that lacks an Origin header but carries Sec-Fetch-Site (recorder polling)", async () => {
    // Browsers do NOT send the `Origin` header on safe-method
    // (GET/HEAD) same-origin requests. The recorder's poll of this
    // endpoint must therefore succeed via the `Sec-Fetch-Site:
    // same-origin` fallback, not via Origin matching.
    const user = await seedUser();
    const session = await seedSession(user.id);
    mockGetActiveUserId.mockResolvedValue(user.id);
    setHeaders({
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "203.0.113.42",
      "user-agent": "Mozilla/5.0 (vitest)",
    });

    const res = await getSessionRoute(
      makeRequest(`/api/sessions/${session.id}`),
      makeContext(session.id),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a GET with neither Origin nor Sec-Fetch-Site (non-browser caller)", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    mockGetActiveUserId.mockResolvedValue(user.id);
    setHeaders({
      "x-forwarded-for": "203.0.113.42",
      "user-agent": "curl/8",
    });

    const res = await getSessionRoute(
      makeRequest(`/api/sessions/${session.id}`),
      makeContext(session.id),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a GET with Sec-Fetch-Site: cross-site", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    mockGetActiveUserId.mockResolvedValue(user.id);
    setHeaders({
      "sec-fetch-site": "cross-site",
      "x-forwarded-for": "203.0.113.42",
      "user-agent": "Mozilla/5.0 (vitest)",
    });

    const res = await getSessionRoute(
      makeRequest(`/api/sessions/${session.id}`),
      makeContext(session.id),
    );
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/*                      Regression: presign rollback                  */
/* ------------------------------------------------------------------ */

describe("upload-url: presign failure rollback (regression)", () => {
  it("rolls the session back to created when presign throws after the state advance", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    mockGetActiveUserId.mockResolvedValue(user.id);

    // Simulate a transient signing failure. The route must catch
    // this AFTER the `created → recording` UPDATE has landed and
    // bring the row back to `created` so the user can retry.
    mockPresign.mockRejectedValueOnce(new Error("kms key access denied"));

    const res = await uploadUrlRoute(
      makeRequest(`/api/sessions/${session.id}/audio/upload-url`, {
        method: "POST",
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(500);

    const [row] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    // If the rollback fired, the row is back in `created` and a
    // retry can proceed. Without the rollback the row would be
    // stuck in `recording` forever.
    expect(row?.state).toBe("created");

    // A subsequent retry must succeed end-to-end.
    mockPresign.mockImplementationOnce(async (args: { key: string }) =>
      PRESIGN_RESPONSE(args.key),
    );
    const retryRes = await uploadUrlRoute(
      makeRequest(`/api/sessions/${session.id}/audio/upload-url`, {
        method: "POST",
      }),
      makeContext(session.id),
    );
    expect(retryRes.status).toBe(201);
  });
});

/* ------------------------------------------------------------------ */
/*                  Regression: HEAD check on /uploaded               */
/* ------------------------------------------------------------------ */

describe("uploaded: local storage existence check (regression)", () => {
  it("returns 409 object_missing when the head check says the object isn't there", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    await startRecording({ sessionId: session.id, userId: user.id });
    mockGetActiveUserId.mockResolvedValue(user.id);
    mockHead.mockResolvedValue({ exists: false, contentLength: null });

    const key = buildAudioKey({ userId: user.id, sessionId: session.id });
    const res = await uploadedRoute(
      makeRequest(`/api/sessions/${session.id}/audio/uploaded`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          file_size_bytes: 1024,
          duration_seconds: 60,
        }),
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("object_missing");

    // Critical: the session must still be in `recording` so a
    // legitimate retry (the client re-uploading the blob) can
    // succeed. Advancing here would brick the session.
    const [row] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(row?.state).toBe("recording");
  });

  it("returns 503 when the storage check itself fails", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    await startRecording({ sessionId: session.id, userId: user.id });
    mockGetActiveUserId.mockResolvedValue(user.id);
    mockHead.mockRejectedValue(new Error("local storage timeout"));

    const key = buildAudioKey({ userId: user.id, sessionId: session.id });
    const res = await uploadedRoute(
      makeRequest(`/api/sessions/${session.id}/audio/uploaded`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          file_size_bytes: 1024,
          duration_seconds: 60,
        }),
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(503);
  });

  it("returns 413 file_too_large when the server-observed size exceeds 400 MB", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    await startRecording({ sessionId: session.id, userId: user.id });
    mockGetActiveUserId.mockResolvedValue(user.id);
    // Server observes 401 MB — just over the 400 MB ceiling.
    const OVER_LIMIT = 401 * 1024 * 1024;
    mockHead.mockResolvedValue({ exists: true, contentLength: OVER_LIMIT });

    const key = buildAudioKey({ userId: user.id, sessionId: session.id });
    const res = await uploadedRoute(
      makeRequest(`/api/sessions/${session.id}/audio/uploaded`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          // Client reports exactly 400 MB to pass schema; server check catches the real size.
          file_size_bytes: 400 * 1024 * 1024,
          duration_seconds: 60,
        }),
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("file_too_large");
  });

  it("returns 409 size_mismatch when the server-observed size diverges grossly from the client claim", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    await startRecording({ sessionId: session.id, userId: user.id });
    mockGetActiveUserId.mockResolvedValue(user.id);
    // Client claims 1 KB; server says 1 MB. Tolerance is 1 KB so
    // this discrepancy must be rejected.
    mockHead.mockResolvedValue({
      exists: true,
      contentLength: 1024 * 1024,
    });

    const key = buildAudioKey({ userId: user.id, sessionId: session.id });
    const res = await uploadedRoute(
      makeRequest(`/api/sessions/${session.id}/audio/uploaded`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          file_size_bytes: 1024,
          duration_seconds: 60,
        }),
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("size_mismatch");
  });

  it("uses the server-observed size, not the client-reported one, in the audio_files row", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    await startRecording({ sessionId: session.id, userId: user.id });
    mockGetActiveUserId.mockResolvedValue(user.id);
    // Server observed the canonical size (e.g. 4096); client off
    // by a few hundred bytes within tolerance.
    mockHead.mockResolvedValue({ exists: true, contentLength: 4096 });
    mockEnqueue.mockResolvedValue(undefined);

    const key = buildAudioKey({ userId: user.id, sessionId: session.id });
    const res = await uploadedRoute(
      makeRequest(`/api/sessions/${session.id}/audio/uploaded`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          file_size_bytes: 4000,
          duration_seconds: 60,
        }),
      }),
      makeContext(session.id),
    );
    expect(res.status).toBe(202);

    const [audio] = await db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.sessionId, session.id));
    expect(audio?.fileSizeBytes).toBe(4096);
  });
});
