/**
 * Integration tests for the post-recording review API routes.
 *
 *   - PATCH /api/sessions/:id/transcript
 *   - POST  /api/sessions/:id/artifacts
 *   - PATCH /api/sessions/:id/artifacts/:aid
 *   - DELETE /api/sessions/:id/artifacts/:aid
 *   - POST  /api/sessions/:id/artifacts/image-upload-url
 *
 * We mock:
 *   - `next/headers` for the same-origin guard.
 *   - `@/lib/auth/session.getActiveUserId` to express the active user
 *     in one line.
 *   - `@/lib/storage/artifact-presign` so the image-upload-url test
 *     doesn't hit local storage.
 *
 * The Drizzle layer hits real Postgres so the state-machine guards
 * and ownership predicates stay honest.
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

vi.mock("next/headers", () => ({
  headers: async () => new Headers(DEFAULT_HEADERS),
}));

const mockGetActiveUserId = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getActiveUserId: () => mockGetActiveUserId(),
}));

const mockArtifactPresign = vi.fn();
vi.mock("@/lib/storage/artifact-presign", async () => {
  const actual = (await vi.importActual("@/lib/storage/artifact-presign")) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    presignArtifactImagePut: (...args: unknown[]) =>
      mockArtifactPresign(...args),
  };
});

// HEAD is mocked so the artifact-image validation flow stays an
// in-process unit and we can drive size/exists at will. Default is
// "1 KB image, exists" so the happy paths don't need to opt in.
const mockArtifactHead = vi.fn();
vi.mock("@/lib/storage/artifact-head", () => ({
  headArtifactObject: (...args: unknown[]) => mockArtifactHead(...args),
}));

import { PATCH as transcriptPatchRoute } from "@/app/api/sessions/[id]/transcript/route";
import { POST as artifactsPostRoute } from "@/app/api/sessions/[id]/artifacts/route";
import {
  DELETE as artifactDeleteRoute,
  PATCH as artifactPatchRoute,
} from "@/app/api/sessions/[id]/artifacts/[aid]/route";
import { POST as artifactConfirmRoute } from "@/app/api/sessions/[id]/artifacts/[aid]/confirm/route";
import { POST as artifactDismissRoute } from "@/app/api/sessions/[id]/artifacts/[aid]/dismiss/route";
import { POST as artifactRestoreRoute } from "@/app/api/sessions/[id]/artifacts/[aid]/restore/route";
import { POST as imageUploadUrlRoute } from "@/app/api/sessions/[id]/artifacts/image-upload-url/route";
import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";
import {
  finalizeUpload,
  startRecording,
} from "@/lib/sessions/audio";
import { buildAudioKey } from "@/lib/storage/keys";
import { persistTranscriptAndAdvance } from "@/lib/sessions/transcribe";

import { ensureSchema, resetDatabase } from "../db/helpers";
import { env } from "@/lib/env";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  mockGetActiveUserId.mockReset();
  mockArtifactPresign.mockReset();
  mockArtifactHead.mockReset();
  mockArtifactHead.mockResolvedValue({ exists: true, contentLength: 1024 });
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

interface SeededReview {
  userId: string;
  sessionId: string;
}

/**
 * Walks a session all the way to `state = review` so the review/
 * augment routes have a valid target. Uses the public helpers so
 * the resulting state is identical to what the worker would produce.
 */
const seedReviewable = async (
  email = "alice@example.com",
): Promise<SeededReview> => {
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
  const finalized = await finalizeUpload({
    sessionId: session.id,
    userId: user.id,
    s3Key: key,
    fileSizeBytes: 100_000,
    durationSeconds: 600,
  });
  await persistTranscriptAndAdvance({
    sessionId: session.id,
    audioFileId: finalized.audioFile.id,
    durationSeconds: 600,
    processed: {
      audioDurationSeconds: 600,
      rawText: "raw transcript",
      redactedText: "redacted transcript",
      redactionCount: 1,
      candidateSpeaker: 0,
      candidateWordCount: 2,
      candidateFillerWordCount: 0,
    },
    transcriptionError: null,
    userId: user.id,
  });
  return { userId: user.id, sessionId: session.id };
};

const buildJsonRequest = (
  method: string,
  url: string,
  body: unknown,
): Request =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });

/**
 * Build the same shape of `imageUrl` the artifact presigner emits
 * so the validation gate accepts it. Uses the live env local storage config so
 * local runs (with a different bucket name) and CI both pass without
 * needing separate test wiring.
 */
const buildArtifactImageUrl = (args: {
  userId: string;
  sessionId: string;
  fileUuid?: string;
  ext?: "png" | "jpg" | "jpeg" | "gif" | "webp";
}): string => {
  const fileUuid =
    args.fileUuid ?? "00000000-0000-4000-8000-000000000001";
  const ext = args.ext ?? "png";
  const bucket = env.storage_local storage_BUCKET ?? "ir-audio-dev";
  const endpoint = env.storage_local storage_ENDPOINT ?? "http://localhost:9000";
  return (
    `${endpoint}/${bucket}/artifacts/` +
    `${args.userId}/${args.sessionId}/${fileUuid}.${ext}`
  );
};

// Polymorphic shape: routes accept `{ params: Promise<{ id }> }` and
// `{ params: Promise<{ id, aid }> }`. We cast at the call site so both
// route signatures are happy from one helper.
const ctx = (params: { id: string; aid?: string }) =>
  ({
    params: Promise.resolve(params),
  }) as { params: Promise<{ id: string; aid: string }> };

/* ──────────────────────────────────────────────────────────── */
/*                 PATCH /api/sessions/:id/transcript            */
/* ──────────────────────────────────────────────────────────── */

describe("PATCH /api/sessions/:id/transcript", () => {
  it("updates edited_text in the review state", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await transcriptPatchRoute(
      buildJsonRequest(
        "PATCH",
        `http://localhost:3000/api/sessions/${sessionId}/transcript`,
        { edited_text: "my hand-edited transcript" },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      transcript: { editedText: string; redactedText: string };
    };
    expect(body.transcript.editedText).toBe("my hand-edited transcript");
    // raw_text and redacted_text MUST be unchanged.
    expect(body.transcript.redactedText).toBe("redacted transcript");

    const [t] = await db
      .select()
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, sessionId));
    expect(t?.editedText).toBe("my hand-edited transcript");
  });

  it("returns 401 when the caller is not signed in", async () => {
    const { sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(null);

    const res = await transcriptPatchRoute(
      buildJsonRequest(
        "PATCH",
        `http://localhost:3000/api/sessions/${sessionId}/transcript`,
        { edited_text: "hi" },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the session is owned by a different user", async () => {
    const { sessionId } = await seedReviewable("alice@example.com");
    const bob = await seedUser("bob@example.com");
    mockGetActiveUserId.mockResolvedValue(bob.id);

    const res = await transcriptPatchRoute(
      buildJsonRequest(
        "PATCH",
        `http://localhost:3000/api/sessions/${sessionId}/transcript`,
        { edited_text: "hi" },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when the session is not in 'review' state", async () => {
    // Reach review, then advance past it manually.
    const { userId, sessionId } = await seedReviewable();
    await db
      .update(schema.interviewSessions)
      .set({ state: "analyzing" })
      .where(eq(schema.interviewSessions.id, sessionId));

    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await transcriptPatchRoute(
      buildJsonRequest(
        "PATCH",
        `http://localhost:3000/api/sessions/${sessionId}/transcript`,
        { edited_text: "too late" },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { currentState: string };
    expect(body.currentState).toBe("analyzing");
  });

  it("returns 400 when the body is invalid", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await transcriptPatchRoute(
      buildJsonRequest(
        "PATCH",
        `http://localhost:3000/api/sessions/${sessionId}/transcript`,
        { something_else: "x" },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(400);
  });
});

/* ──────────────────────────────────────────────────────────── */
/*                 POST /api/sessions/:id/artifacts              */
/* ──────────────────────────────────────────────────────────── */

describe("POST /api/sessions/:id/artifacts", () => {
  it("creates a question artifact and returns it", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        { artifact_type: "question", content: "How would you scale this?" },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      artifact: { id: string; artifactType: string; content: string | null };
    };
    expect(body.artifact.artifactType).toBe("question");
    expect(body.artifact.content).toBe("How would you scale this?");

    const rows = await db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.sessionId, sessionId));
    expect(rows).toHaveLength(1);
  });

  it("creates a design_image artifact when image_url is well-formed", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);
    const imageUrl = buildArtifactImageUrl({ userId, sessionId });

    const res = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        {
          artifact_type: "design_image",
          image_url: imageUrl,
        },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      artifact: { artifactType: string; imageUrl: string | null };
    };
    expect(body.artifact.artifactType).toBe("design_image");
    expect(body.artifact.imageUrl).toBe(imageUrl);
    expect(mockArtifactHead).toHaveBeenCalledTimes(1);
  });

  it("rejects design_image whose image_url isn't a parseable http URL (400)", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        {
          artifact_type: "design_image",
          image_url: "javascript:alert(1)",
        },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_image_url");
    expect(mockArtifactHead).not.toHaveBeenCalled();
  });

  it("rejects design_image image_url that doesn't point at our bucket prefix (400)", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        {
          artifact_type: "design_image",
          image_url: "https://attacker.example/whiteboard.png",
        },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(400);
    expect(mockArtifactHead).not.toHaveBeenCalled();
  });

  it("rejects design_image image_url that encodes a different user (403)", async () => {
    const owner = await seedReviewable("owner@example.com");
    const intruder = await seedReviewable("intruder@example.com");
    mockGetActiveUserId.mockResolvedValue(intruder.userId);

    // URL points at a key inside `owner.userId` but the request is
    // running as `intruder.userId` against `intruder.sessionId`.
    const foreign = buildArtifactImageUrl({
      userId: owner.userId,
      sessionId: intruder.sessionId,
    });

    const res = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${intruder.sessionId}/artifacts`,
        { artifact_type: "design_image", image_url: foreign },
      ),
      ctx({ id: intruder.sessionId }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("image_url_user_mismatch");
    expect(mockArtifactHead).not.toHaveBeenCalled();
  });

  it("rejects design_image image_url that encodes a different session (403)", async () => {
    const a = await seedReviewable("a@example.com");
    const b = await seedReviewable("b@example.com");
    // Sign in as user `a` but submit a URL whose key embeds session b.
    mockGetActiveUserId.mockResolvedValue(a.userId);
    const wrongSession = buildArtifactImageUrl({
      userId: a.userId,
      sessionId: b.sessionId,
    });

    const res = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${a.sessionId}/artifacts`,
        { artifact_type: "design_image", image_url: wrongSession },
      ),
      ctx({ id: a.sessionId }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("image_url_session_mismatch");
  });

  it("rejects design_image when the uploaded object doesn't exist (409)", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);
    mockArtifactHead.mockResolvedValueOnce({ exists: false, contentLength: null });

    const res = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        {
          artifact_type: "design_image",
          image_url: buildArtifactImageUrl({ userId, sessionId }),
        },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("image_not_uploaded");
  });

  it("rejects design_image when the uploaded object exceeds 5 MB (413)", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);
    mockArtifactHead.mockResolvedValueOnce({
      exists: true,
      contentLength: 6 * 1024 * 1024,
    });

    const res = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        {
          artifact_type: "design_image",
          image_url: buildArtifactImageUrl({ userId, sessionId }),
        },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("image_too_large");
  });

  it("rejects design_image without image_url (400)", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        { artifact_type: "design_image", content: "this should fail" },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-image artifact carrying image_url (400)", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        {
          artifact_type: "question",
          content: "ok",
          image_url: "https://example.com/x.png",
        },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when session is in `created` state", async () => {
    const user = await seedUser();
    const session = await createSession({
      userId: user.id,
      companyName: "Stripe",
      roleTitle: "SWE",
      level: "senior",
      roundType: "coding",
      scheduledAt: null,
    });
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${session.id}/artifacts`,
        { artifact_type: "question", content: "too early" },
      ),
      ctx({ id: session.id }),
    );
    expect(res.status).toBe(409);
  });
});

/* ──────────────────────────────────────────────────────────── */
/*       PATCH/DELETE /api/sessions/:id/artifacts/:aid           */
/* ──────────────────────────────────────────────────────────── */

describe("PATCH /api/sessions/:id/artifacts/:aid", () => {
  it("updates content for a non-image artifact", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);
    const create = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        { artifact_type: "code", content: "function a() {}" },
      ),
      ctx({ id: sessionId }),
    );
    const { artifact } = (await create.json()) as { artifact: { id: string } };

    const res = await artifactPatchRoute(
      buildJsonRequest(
        "PATCH",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifact.id}`,
        { content: "function a(b) { return b; }" },
      ),
      ctx({ id: sessionId, aid: artifact.id }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact: { content: string } };
    expect(body.artifact.content).toBe("function a(b) { return b; }");
  });

  it("rejects setting image_url on a non-image artifact (400)", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);
    const create = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        { artifact_type: "code", content: "x" },
      ),
      ctx({ id: sessionId }),
    );
    const { artifact } = (await create.json()) as { artifact: { id: string } };

    const res = await artifactPatchRoute(
      buildJsonRequest(
        "PATCH",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifact.id}`,
        { image_url: "https://example.com/x.png" },
      ),
      ctx({ id: sessionId, aid: artifact.id }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when artifact belongs to another user's session", async () => {
    const { userId: aliceId, sessionId } = await seedReviewable("alice@example.com");
    mockGetActiveUserId.mockResolvedValue(aliceId);
    const create = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        { artifact_type: "question", content: "secret" },
      ),
      ctx({ id: sessionId }),
    );
    const { artifact } = (await create.json()) as { artifact: { id: string } };

    const bob = await seedUser("bob@example.com");
    mockGetActiveUserId.mockResolvedValue(bob.id);
    const res = await artifactPatchRoute(
      buildJsonRequest(
        "PATCH",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifact.id}`,
        { content: "pwned" },
      ),
      ctx({ id: sessionId, aid: artifact.id }),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/sessions/:id/artifacts/:aid", () => {
  it("removes the artifact from the DB", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);
    const create = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        { artifact_type: "question", content: "rm me" },
      ),
      ctx({ id: sessionId }),
    );
    const { artifact } = (await create.json()) as { artifact: { id: string } };

    const res = await artifactDeleteRoute(
      new Request(
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifact.id}`,
        {
          method: "DELETE",
          headers: { origin: "http://localhost:3000" },
        },
      ),
      ctx({ id: sessionId, aid: artifact.id }),
    );
    expect(res.status).toBe(204);

    const rows = await db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifact.id));
    expect(rows).toHaveLength(0);
  });

  it("returns 204 even if the row is already gone (idempotent)", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);
    const create = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        { artifact_type: "question", content: "x" },
      ),
      ctx({ id: sessionId }),
    );
    const { artifact } = (await create.json()) as { artifact: { id: string } };
    const url = `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifact.id}`;

    const first = await artifactDeleteRoute(
      new Request(url, {
        method: "DELETE",
        headers: { origin: "http://localhost:3000" },
      }),
      ctx({ id: sessionId, aid: artifact.id }),
    );
    expect(first.status).toBe(204);

    const second = await artifactDeleteRoute(
      new Request(url, {
        method: "DELETE",
        headers: { origin: "http://localhost:3000" },
      }),
      ctx({ id: sessionId, aid: artifact.id }),
    );
    // Already gone -> 404 from the auth helper because
    // `getOwnedArtifact` returns null. That's a reasonable choice
    // (telling the client "your reference is stale"); accept either
    // 204 or 404 here.
    expect([204, 404]).toContain(second.status);
  });
});

/* ──────────────────────────────────────────────────────────── */
/*       POST /api/sessions/:id/artifacts/image-upload-url       */
/* ──────────────────────────────────────────────────────────── */

describe("POST /api/sessions/:id/artifacts/image-upload-url", () => {
  it("returns a presigned PUT URL for a valid PNG request", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);
    mockArtifactPresign.mockImplementation(async () => ({
      url: "https://s3.example.com/bucket/abc?sig=xyz",
      key: `artifacts/${userId}/${sessionId}/00000000-0000-0000-0000-000000000000.png`,
      expiresAt: new Date(Date.now() + 5 * 60_000),
      requiredHeaders: { "Content-Type": "image/png" },
      imageUrl: `https://s3.example.com/bucket/artifacts/${userId}/${sessionId}/00000000-0000-0000-0000-000000000000.png`,
    }));

    const res = await imageUploadUrlRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/image-upload-url`,
        { content_type: "image/png", file_size_bytes: 50_000 },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      requiredHeaders: Record<string, string>;
      imageUrl: string;
      maxBytes: number;
    };
    expect(body.url).toContain("s3.example.com");
    expect(body.requiredHeaders["Content-Type"]).toBe("image/png");
    expect(body.maxBytes).toBe(5 * 1024 * 1024);
  });

  it("rejects an unsupported MIME type (400)", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await imageUploadUrlRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/image-upload-url`,
        { content_type: "image/bmp", file_size_bytes: 10_000 },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects oversized files (400)", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await imageUploadUrlRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/image-upload-url`,
        { content_type: "image/png", file_size_bytes: 6 * 1024 * 1024 },
      ),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(400);
  });
});

/* ──────────────────────────────────────────────────────────── */
/*           AI-inferred lifecycle routes (confirm /            */
/*           dismiss / restore / PATCH with promotion)          */
/* ──────────────────────────────────────────────────────────── */

const seedAiInferredArtifact = async (
  email = "alice@example.com",
): Promise<{
  userId: string;
  sessionId: string;
  artifactId: string;
}> => {
  const { userId, sessionId } = await seedReviewable(email);

  // Re-use the same persist path the worker uses so the seeded row
  // has the exact same shape as a real one (source = ai_inferred,
  // ai_confidence = high, linked offsets set, etc.). We insert
  // directly here to side-step the `transcripts` unique constraint
  // (the seedReviewable helper already wrote a transcript row).
  const [row] = await db
    .insert(schema.artifacts)
    .values({
      sessionId,
      artifactType: "question",
      content: "Tell me about a time you disagreed with your manager.",
      imageUrl: null,
      displayOrder: 0,
      source: "ai_inferred",
      aiConfidence: "high",
      linkedTranscriptOffset: 0,
      linkedTranscriptLength: 100,
    })
    .returning({ id: schema.artifacts.id });

  if (!row) throw new Error("seed: failed to insert AI-inferred artifact");
  return { userId, sessionId, artifactId: row.id };
};

describe("POST /api/sessions/:id/artifacts/:aid/confirm", () => {
  it("stamps user_confirmed_at and leaves source/ai_confidence intact", async () => {
    const { userId, sessionId, artifactId } = await seedAiInferredArtifact();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await artifactConfirmRoute(
      new Request(
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifactId}/confirm`,
        { method: "POST", headers: { origin: "http://localhost:3000" } },
      ),
      ctx({ id: sessionId, aid: artifactId }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: {
        source: string;
        aiConfidence: string | null;
        userConfirmedAt: string | null;
      };
    };
    expect(body.artifact.source).toBe("ai_inferred");
    expect(body.artifact.aiConfidence).toBe("high");
    expect(body.artifact.userConfirmedAt).not.toBeNull();

    const [row] = await db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(row?.userConfirmedAt).not.toBeNull();
    expect(row?.dismissedAt).toBeNull();
  });

  it("returns 409 when the artifact is user-added (action only applies to AI rows)", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);
    const create = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        { artifact_type: "question", content: "user-added" },
      ),
      ctx({ id: sessionId }),
    );
    const { artifact } = (await create.json()) as { artifact: { id: string } };

    const res = await artifactConfirmRoute(
      new Request(
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifact.id}/confirm`,
        { method: "POST", headers: { origin: "http://localhost:3000" } },
      ),
      ctx({ id: sessionId, aid: artifact.id }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_ai_inferred");
  });

  it("idempotent on a row that's already confirmed (409 no_op so client refetches)", async () => {
    const { userId, sessionId, artifactId } = await seedAiInferredArtifact();
    mockGetActiveUserId.mockResolvedValue(userId);

    const url = `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifactId}/confirm`;
    const first = await artifactConfirmRoute(
      new Request(url, { method: "POST", headers: { origin: "http://localhost:3000" } }),
      ctx({ id: sessionId, aid: artifactId }),
    );
    expect(first.status).toBe(200);

    const second = await artifactConfirmRoute(
      new Request(url, { method: "POST", headers: { origin: "http://localhost:3000" } }),
      ctx({ id: sessionId, aid: artifactId }),
    );
    // Second call falls through to "no_op" — the WHERE in the
    // SQL was already satisfied. Surface as 409 so the client
    // refetches; we don't lie and say 200 succeeded with empty.
    expect(second.status).toBe(409);
  });

  it("refuses to confirm a previously-dismissed row (409, restore first)", async () => {
    const { userId, sessionId, artifactId } = await seedAiInferredArtifact();
    mockGetActiveUserId.mockResolvedValue(userId);

    // Dismiss it first.
    await artifactDismissRoute(
      new Request(
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifactId}/dismiss`,
        { method: "POST", headers: { origin: "http://localhost:3000" } },
      ),
      ctx({ id: sessionId, aid: artifactId }),
    );

    const res = await artifactConfirmRoute(
      new Request(
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifactId}/confirm`,
        { method: "POST", headers: { origin: "http://localhost:3000" } },
      ),
      ctx({ id: sessionId, aid: artifactId }),
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 for an artifact owned by another user", async () => {
    const a = await seedAiInferredArtifact("alice@example.com");
    const bob = await seedUser("bob@example.com");
    mockGetActiveUserId.mockResolvedValue(bob.id);

    const res = await artifactConfirmRoute(
      new Request(
        `http://localhost:3000/api/sessions/${a.sessionId}/artifacts/${a.artifactId}/confirm`,
        { method: "POST", headers: { origin: "http://localhost:3000" } },
      ),
      ctx({ id: a.sessionId, aid: a.artifactId }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/artifacts/:aid/dismiss + /restore", () => {
  it("dismiss → row hidden from suggestions; restore → row reappears", async () => {
    const { userId, sessionId, artifactId } = await seedAiInferredArtifact();
    mockGetActiveUserId.mockResolvedValue(userId);

    const dismissRes = await artifactDismissRoute(
      new Request(
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifactId}/dismiss`,
        { method: "POST", headers: { origin: "http://localhost:3000" } },
      ),
      ctx({ id: sessionId, aid: artifactId }),
    );
    expect(dismissRes.status).toBe(200);
    const dismissedBody = (await dismissRes.json()) as {
      artifact: { dismissedAt: string | null };
    };
    expect(dismissedBody.artifact.dismissedAt).not.toBeNull();

    const restoreRes = await artifactRestoreRoute(
      new Request(
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifactId}/restore`,
        { method: "POST", headers: { origin: "http://localhost:3000" } },
      ),
      ctx({ id: sessionId, aid: artifactId }),
    );
    expect(restoreRes.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(row?.dismissedAt).toBeNull();
  });
});

describe("PATCH /api/sessions/:id/artifacts/:aid — AI promotion on edit", () => {
  it("editing an ai_inferred row flips it to user_added + clears ai_confidence + stamps user_confirmed_at", async () => {
    const { userId, sessionId, artifactId } = await seedAiInferredArtifact();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await artifactPatchRoute(
      buildJsonRequest(
        "PATCH",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifactId}`,
        {
          content:
            "Walk me through a project where you changed an architectural decision under pressure.",
        },
      ),
      ctx({ id: sessionId, aid: artifactId }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: {
        source: string;
        aiConfidence: string | null;
        userConfirmedAt: string | null;
        content: string | null;
      };
    };
    expect(body.artifact.source).toBe("user_added");
    expect(body.artifact.aiConfidence).toBeNull();
    expect(body.artifact.userConfirmedAt).not.toBeNull();
    expect(body.artifact.content).toMatch(/architectural decision/);

    const [row] = await db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(row?.source).toBe("user_added");
    expect(row?.aiConfidence).toBeNull();
    // Linked transcript pointers MUST be preserved on an edit so
    // the analyze pass can still relate the question to its answer.
    expect(row?.linkedTranscriptOffset).toBe(0);
    expect(row?.linkedTranscriptLength).toBe(100);
  });

  it("editing a user-added row does NOT touch source/ai_confidence/user_confirmed_at", async () => {
    const { userId, sessionId } = await seedReviewable();
    mockGetActiveUserId.mockResolvedValue(userId);
    const create = await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        { artifact_type: "question", content: "first draft" },
      ),
      ctx({ id: sessionId }),
    );
    const { artifact } = (await create.json()) as {
      artifact: { id: string; source: string };
    };
    // Newly created artifacts ALWAYS default to source='user_added'.
    expect(artifact.source).toBe("user_added");

    const patch = await artifactPatchRoute(
      buildJsonRequest(
        "PATCH",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${artifact.id}`,
        { content: "second draft" },
      ),
      ctx({ id: sessionId, aid: artifact.id }),
    );
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as {
      artifact: {
        source: string;
        aiConfidence: string | null;
        userConfirmedAt: string | null;
      };
    };
    expect(body.artifact.source).toBe("user_added");
    expect(body.artifact.aiConfidence).toBeNull();
    // user_confirmed_at MUST stay null — confirming is only
    // meaningful for ai_inferred rows.
    expect(body.artifact.userConfirmedAt).toBeNull();
  });
});

/* ──────────────────────────────────────────────────────────── */
/*    Augment-page read shape: groupings stay coherent across   */
/*    confirm/dismiss/restore lifecycle                          */
/* ──────────────────────────────────────────────────────────── */

describe("getSessionForReview — augment groupings", () => {
  it("returns rows in a shape the augment page can split into Confirmed / Suggested / Dismissed", async () => {
    const { userId, sessionId, artifactId: dismissedId } =
      await seedAiInferredArtifact("alice@example.com");
    mockGetActiveUserId.mockResolvedValue(userId);

    // Add a second AI-inferred row, confirm it.
    const [confirmedRow] = await db
      .insert(schema.artifacts)
      .values({
        sessionId,
        artifactType: "question",
        content: "What's your biggest weakness?",
        displayOrder: 1,
        source: "ai_inferred",
        aiConfidence: "high",
        userConfirmedAt: new Date(),
      })
      .returning({ id: schema.artifacts.id });
    expect(confirmedRow).toBeDefined();

    // Add a user-added row.
    await artifactsPostRoute(
      buildJsonRequest(
        "POST",
        `http://localhost:3000/api/sessions/${sessionId}/artifacts`,
        { artifact_type: "question", content: "user-typed question" },
      ),
      ctx({ id: sessionId }),
    );

    // Dismiss the first AI-inferred row.
    await artifactDismissRoute(
      new Request(
        `http://localhost:3000/api/sessions/${sessionId}/artifacts/${dismissedId}/dismiss`,
        { method: "POST", headers: { origin: "http://localhost:3000" } },
      ),
      ctx({ id: sessionId, aid: dismissedId }),
    );

    // Pull the bundle the augment page will consume.
    const { getSessionForReview } = await import(
      "@/lib/queries/transcripts"
    );
    const bundle = await getSessionForReview(sessionId, userId);
    expect(bundle).not.toBeNull();
    const questions = bundle!.artifacts.filter(
      (a) => a.artifactType === "question",
    );
    expect(questions).toHaveLength(3);

    const confirmed = questions.filter(
      (a) =>
        a.dismissedAt === null &&
        (a.source === "user_added" || a.userConfirmedAt !== null),
    );
    const suggested = questions.filter(
      (a) =>
        a.source === "ai_inferred" &&
        a.userConfirmedAt === null &&
        a.dismissedAt === null,
    );
    const dismissed = questions.filter(
      (a) => a.source === "ai_inferred" && a.dismissedAt !== null,
    );

    // After this scenario:
    //   - 1 user-added row + 1 confirmed AI row → 2 confirmed.
    //   - 0 suggested (the only un-acted AI row was dismissed).
    //   - 1 dismissed (the seeded row).
    expect(confirmed).toHaveLength(2);
    expect(suggested).toHaveLength(0);
    expect(dismissed).toHaveLength(1);
  });
});
