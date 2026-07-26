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

const mockEnqueueAnalyzeSession = vi.fn();
vi.mock("@/job-runner", () => ({
  enqueueAnalyzeSession: (...args: unknown[]) =>
    mockEnqueueAnalyzeSession(...args),
}));

const mockRunAnalyzeInline = vi.fn();
vi.mock("@/lib/sessions/analyze-inline", () => ({
  runAnalyzeInline: (...args: unknown[]) => mockRunAnalyzeInline(...args),
}));

import type * as EnvModule from "@/lib/env";

const envOverrides = vi.hoisted(() => ({ job-runnerEventKey: null as string | null }));
vi.mock("@/lib/env", async () => {
  const real = await vi.importActual<typeof EnvModule>("@/lib/env");
  return {
    ...real,
    get env() {
      return {
        ...real.env,
        JOB_RUNNER_EVENT_KEY:
          envOverrides.job-runnerEventKey ?? real.env.JOB_RUNNER_EVENT_KEY,
      };
    },
  };
});

import { POST } from "@/app/api/sessions/[id]/analyze/route";
import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  mockGetActiveUserId.mockReset();
  mockEnqueueAnalyzeSession.mockReset();
  mockEnqueueAnalyzeSession.mockResolvedValue(undefined);
  mockRunAnalyzeInline.mockReset();
  mockRunAnalyzeInline.mockRejectedValue(
    new Error("inline_disabled_in_test"),
  );
  setHeaders(null);
  envOverrides.job-runnerEventKey = null;
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

const seedSessionInReview = async (
  userId: string,
  durationSeconds = 600,
) => {
  const row = await createSession({
    userId,
    companyName: "Stripe",
    roleTitle: "Backend Engineer",
    level: "senior",
    roundType: "coding",
    scheduledAt: null,
  });
  await db
    .update(schema.interviewSessions)
    .set({ state: "review" })
    .where(eq(schema.interviewSessions.id, row.id));
  await db.insert(schema.transcripts).values({
    sessionId: row.id,
    rawText: "raw text",
    redactedText: "redacted text",
    redactionCount: 0,
    language: "en",
    wordCount: 50,
    durationSeconds,
    fillerWordCount: 3,
  });
  return row;
};

const buildRoute = (id: string) => ({
  params: Promise.resolve({ id }),
});

const post = (id: string) =>
  new Request(`http://localhost/api/sessions/${id}/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

describe("POST /api/sessions/:id/analyze — auth + origin", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await POST(post("00000000-0000-0000-0000-000000000000"), buildRoute("00000000-0000-0000-0000-000000000000"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when origin is missing", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    setHeaders({ "x-forwarded-for": "1.2.3.4", "user-agent": "vitest" });
    const res = await POST(post("00000000-0000-0000-0000-000000000000"), buildRoute("00000000-0000-0000-0000-000000000000"));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/sessions/:id/analyze — duration guard", () => {
  it("returns 422 for recordings > 120 minutes", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 121 * 60);

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("duration_out_of_range");
    expect(mockEnqueueAnalyzeSession).not.toHaveBeenCalled();
  });

  it("happy path: 30-min session fires the event and returns 202", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 30 * 60);

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(202);

    expect(mockEnqueueAnalyzeSession).toHaveBeenCalledOnce();
    expect(mockEnqueueAnalyzeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        userId: user.id,
      }),
    );
  });
});

describe("POST /api/sessions/:id/analyze — state machine guard", () => {
  it("returns 409 when the session is in `created`", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const row = await createSession({
      userId: user.id,
      companyName: "Stripe",
      roleTitle: "Backend Engineer",
      level: "senior",
      roundType: "coding",
      scheduledAt: null,
    });

    const res = await POST(post(row.id), buildRoute(row.id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("state_mismatch");
    expect(mockEnqueueAnalyzeSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/sessions/:id/analyze — transcript guards", () => {
  it("returns 409 when the transcript has a transcription_error", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60);
    await db
      .update(schema.transcripts)
      .set({ transcriptionError: "transcription_500" })
      .where(eq(schema.transcripts.sessionId, session.id));

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("transcript_failed");
  });

  it("returns 404 for an unknown session id", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await POST(
      post("00000000-0000-0000-0000-000000000000"),
      buildRoute("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/analyze — soft-delete (H4)", () => {
  it("returns 404 for a soft-deleted session", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60);
    await db
      .update(schema.interviewSessions)
      .set({ deletedAt: new Date(), state: "deleted" })
      .where(eq(schema.interviewSessions.id, session.id));

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(404);
    expect(mockEnqueueAnalyzeSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/sessions/:id/analyze — dev fire-and-forget fallback", () => {
  it("returns 202 immediately, leaves the session in `analyzing`, and invokes the inline helper in the background", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60);

    mockEnqueueAnalyzeSession.mockRejectedValueOnce(new Error("job-runner down"));

    let resolveInline!: () => void;
    const inlineCalled = new Promise<void>((resolve) => {
      resolveInline = resolve;
    });
    mockRunAnalyzeInline.mockImplementationOnce(async () => {
      resolveInline();
      return {
        reportId: "00000000-0000-4000-8000-000000000001",
        modelVersion: "placeholder@dev",
        rubricVersion: "v1",
      };
    });

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(202);

    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("analyzing");

    await inlineCalled;
  });
});

describe("POST /api/sessions/:id/analyze — body size cap (M4)", () => {
  it("returns 413 when content-length exceeds the cap", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    setHeaders({
      ...DEFAULT_HEADERS,
      "content-length": "1048576",
    });

    const res = await POST(
      post("00000000-0000-0000-0000-000000000000"),
      buildRoute("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(413);
    expect(mockEnqueueAnalyzeSession).not.toHaveBeenCalled();
  });
});
