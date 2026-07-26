/**
 * Integration tests for `POST /api/sessions/:id/reset`.
 *
 * Two reset paths converge on this route:
 *
 *   1. `failed` sessions (worker pipeline blew up). Most common
 *      path in practice; the route flips state to `complete` if a
 *      prior report exists or `review` for a first analysis.
 *
 *   2. `complete` sessions whose latest report is a fallback stub
 *      (model_version starts with `fallback:`). The worker writes
 *      these when the LLM call fails partway through but we can
 *      still produce a degraded report — the row lands in
 *      `complete` with a refunded credit, and the report page
 *      surfaces the `FallbackRetryBanner` with a Retry button.
 *      Hitting this route from THAT button used to 409 because the
 *      route only accepted `failed`. The fix lives in this branch;
 *      the `complete + fallback report` test below pins it.
 *
 * Healthy `complete` sessions (or `review` / `analyzing` / etc.)
 * still get a 409 — there's nothing to reset.
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

import { POST } from "@/app/api/sessions/[id]/reset/route";
import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";
import { FALLBACK_MODEL_VERSION_PREFIX } from "@/lib/llm";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  mockGetActiveUserId.mockReset();
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

const seedSession = async (
  userId: string,
  state: "failed" | "complete" | "review" | "analyzing",
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
    .set({ state })
    .where(eq(schema.interviewSessions.id, row.id));
  return row;
};

const seedReport = async (
  sessionId: string,
  modelVersion = "llm-large",
) => {
  const [r] = await db
    .insert(schema.reports)
    .values({
      sessionId,
      reportJson: { placeholder: true },
      modelVersion,
      rubricVersion: "test",
    })
    .returning({ id: schema.reports.id });
  return r;
};

const buildRoute = (id: string) => ({
  params: Promise.resolve({ id }),
});

const post = (id: string) =>
  new Request(`http://localhost/api/sessions/${id}/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

describe("POST /api/sessions/:id/reset — auth + origin", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await POST(
      post("00000000-0000-0000-0000-000000000000"),
      buildRoute("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when origin is missing", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    setHeaders({ "x-forwarded-for": "1.2.3.4", "user-agent": "vitest" });
    const res = await POST(
      post("00000000-0000-0000-0000-000000000000"),
      buildRoute("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/sessions/:id/reset — failed branch", () => {
  it("flips a `failed` session WITHOUT a prior report back to `review`", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSession(user.id, "failed");

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.newState).toBe("review");

    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("review");
  });

  it("flips a `failed` session WITH a prior report back to `complete`", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSession(user.id, "failed");
    await seedReport(session.id);

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.newState).toBe("complete");

    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("complete");
  });

  it("writes a `session.reset` audit row on the failed branch", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSession(user.id, "failed");

    await POST(post(session.id), buildRoute(session.id));

    // `createCredentialsUser` writes its own `user.created` audit
    // row, so filter to the event we actually care about.
    const audits = (
      await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.userId, user.id))
    ).filter((a) => a.eventType === "session.reset");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventData).toMatchObject({
      sessionId: session.id,
      previousState: "failed",
      newState: "review",
    });
  });
});

describe("POST /api/sessions/:id/reset — complete + fallback report", () => {
  // The fix this branch adds. Previously this returned 409 with
  // "Session is in state 'complete'; reset only applies to failed
  // sessions." — exactly the bug the FallbackRetryBanner ran into.
  it("returns 200 with newState=`complete` when the latest report is a fallback stub", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSession(user.id, "complete");
    await seedReport(
      session.id,
      `${FALLBACK_MODEL_VERSION_PREFIX}llm_validation_failed`,
    );

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.newState).toBe("complete");
  });

  it("does NOT change session state on the fallback path", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSession(user.id, "complete");
    await seedReport(
      session.id,
      `${FALLBACK_MODEL_VERSION_PREFIX}thin_transcript`,
    );

    await POST(post(session.id), buildRoute(session.id));

    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("complete");
  });

  it("writes an audit row marked `fallbackRetry: true` on the fallback path", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSession(user.id, "complete");
    await seedReport(
      session.id,
      `${FALLBACK_MODEL_VERSION_PREFIX}onFailure:boom`,
    );

    await POST(post(session.id), buildRoute(session.id));

    const audits = (
      await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.userId, user.id))
    ).filter((a) => a.eventType === "session.reset");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventData).toMatchObject({
      sessionId: session.id,
      previousState: "complete",
      newState: "complete",
      fallbackRetry: true,
    });
  });

  // The fallback gate looks at the LATEST report only — that's the
  // one the user sees on the report page, and the one whose
  // `fallback:` prefix gates the FallbackRetryBanner. A historical
  // fallback that has since been superseded by a successful re-run
  // must NOT keep the session reset-able forever.
  it("uses the LATEST report's modelVersion (a healthy newer report blocks reset)", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSession(user.id, "complete");
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { placeholder: true },
      modelVersion: `${FALLBACK_MODEL_VERSION_PREFIX}llm_error`,
      rubricVersion: "test",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { placeholder: true },
      modelVersion: "llm-large",
      rubricVersion: "test",
      createdAt: new Date(),
    });

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("state_mismatch");
  });
});

describe("POST /api/sessions/:id/reset — 409 for healthy non-failed states", () => {
  it("returns 409 for a `complete` session with a healthy (non-fallback) report", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSession(user.id, "complete");
    await seedReport(session.id, "llm-large");

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("state_mismatch");
    expect(body.message).toMatch(/state 'complete'/);
  });

  it("returns 409 for a `complete` session with NO report at all", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSession(user.id, "complete");

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(409);
  });

  it("returns 409 for a `review` session", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSession(user.id, "review");

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(409);
  });

  it("returns 409 for an `analyzing` session", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSession(user.id, "analyzing");

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(409);
  });
});

describe("POST /api/sessions/:id/reset — ownership + soft-delete", () => {
  it("returns 404 for a session owned by a different user", async () => {
    const owner = await seedUser("owner@example.com");
    const intruder = await seedUser("intruder@example.com");
    mockGetActiveUserId.mockResolvedValue(intruder.id);
    const session = await seedSession(owner.id, "failed");

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(404);

    // Owner's session left alone.
    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("failed");
  });

  it("returns 404 for a soft-deleted session", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSession(user.id, "failed");
    await db
      .update(schema.interviewSessions)
      .set({ deletedAt: new Date(), state: "deleted" })
      .where(eq(schema.interviewSessions.id, session.id));

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(404);
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
