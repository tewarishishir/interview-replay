/**
 * Integration tests for `POST /api/sessions/:id/analyze`.
 *
 * The route's headline behaviors per spec:
 *   - 402 Payment Required when balance < required.
 *   - Re-analysis within 24 hours of the most-recent report
 *     charges 0 credits.
 *   - 422 for recordings > 120 minutes.
 *   - 409 when the session isn't in `review` or `complete`.
 *   - 202 with creditsCharged on the happy path, plus the
 *     job runner event is fired with the right payload.
 *
 * We mock `@/job-runner` (the analyze-session enqueue helper) so the
 * test doesn't require an job runner dev server, but still exercise
 * the rest of the route end-to-end against the real local DB.
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

const mockEnqueueAnalyzeSession = vi.fn();
vi.mock("@/job-runner", () => ({
  enqueueAnalyzeSession: (...args: unknown[]) =>
    mockEnqueueAnalyzeSession(...args),
}));

// The route's dev fallback dynamically imports `runAnalyzeInline` when
// the job runner publish fails AND `JOB_RUNNER_EVENT_KEY` is unset. In test
// it would otherwise reach LLM provider (or build a placeholder report
// and write to the DB), so we mock it. Default behaviour is "rejects";
// individual tests `mockResolvedValueOnce` (or
// `mockImplementationOnce`) to assert other paths.
const mockRunAnalyzeInline = vi.fn();
vi.mock("@/lib/sessions/analyze-inline", () => ({
  runAnalyzeInline: (...args: unknown[]) => mockRunAnalyzeInline(...args),
}));

// Toggle for `env.JOB_RUNNER_EVENT_KEY` per test. The route branches on
// this to decide between the dev fire-and-forget inline fallback
// (key unset) and the production "job runner is down → roll back the
// consume → 502" path (key set). Defaulting to `null` keeps the
// majority of tests on the dev path, which mirrors the local
// development setup the route was originally written for.
//
import type * as EnvModule from "@/lib/env";

// Hoisted because `vi.mock` factories run before module-level
// `let` initializations — without `vi.hoisted` the mock would
// reference the variable before the `let` line had executed, and
// the import graph load would crash with a TDZ ReferenceError.
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
  // Default: inline fallback rejects. Tests that exercise the dev
  // fire-and-forget happy path override with `mockResolvedValueOnce`.
  mockRunAnalyzeInline.mockRejectedValue(
    new Error("inline_disabled_in_test"),
  );
  setHeaders(null);
  // Default to "dev" (key unset). The production-path tests opt in
  // by setting this in the test body before invoking the route.
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

const setBalance = async (userId: string, balance: number) => {
  await db
    .update(schema.users)
    .set({ creditBalance: balance })
    .where(eq(schema.users.id, userId));
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

describe("POST /api/sessions/:id/analyze — 402 insufficient credits", () => {
  it("returns 402 when balance < required and does NOT enqueue the worker", async () => {
    const user = await seedUser();
    await setBalance(user.id, 0);
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60); // 1 credit

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("insufficient_credits");
    expect(body.required).toBe(1);
    expect(body.available).toBe(0);

    expect(mockEnqueueAnalyzeSession).not.toHaveBeenCalled();
    // Session state untouched.
    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("review");
  });
});

describe("POST /api/sessions/:id/analyze — duration buckets", () => {
  it("returns 422 for recordings > 120 minutes", async () => {
    const user = await seedUser();
    await setBalance(user.id, 10);
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 121 * 60);

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("duration_out_of_range");
    expect(mockEnqueueAnalyzeSession).not.toHaveBeenCalled();
  });

  it("happy path: 30-min session charges 1 credit, fires the event, returns 202", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 30 * 60);

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.creditsCharged).toBe(1);
    expect(body.isFreeReanalysis).toBe(false);
    expect(body.balanceAfter).toBe(4);

    expect(mockEnqueueAnalyzeSession).toHaveBeenCalledOnce();
    expect(mockEnqueueAnalyzeSession).toHaveBeenCalledWith({
      sessionId: session.id,
      userId: user.id,
      isFreeReanalysis: false,
      creditsCharged: 1,
    });
  });

  it("happy path: 60-min session charges 2 credits", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60);

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.creditsCharged).toBe(2);
    expect(body.balanceAfter).toBe(3);
  });
});

describe("POST /api/sessions/:id/analyze — re-analysis within 24h is free", () => {
  it("charges 0 credits when a report exists from <24h ago", async () => {
    const user = await seedUser();
    await setBalance(user.id, 0); // intentionally zero — must NOT 402
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60);
    // Bump session to `complete` and seed a recent report.
    await db
      .update(schema.interviewSessions)
      .set({ state: "complete" })
      .where(eq(schema.interviewSessions.id, session.id));
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { placeholder: true },
      modelVersion: "test",
      rubricVersion: "test",
      // 1 hour ago — well inside the 24h window.
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.creditsCharged).toBe(0);
    expect(body.isFreeReanalysis).toBe(true);
    // Balance untouched.
    expect(body.balanceAfter).toBe(0);

    expect(mockEnqueueAnalyzeSession).toHaveBeenCalledWith({
      sessionId: session.id,
      userId: user.id,
      isFreeReanalysis: true,
      creditsCharged: 0,
    });

    // Session advanced to `analyzing`, ledger has a delta=0 row.
    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("analyzing");
    const [charge] = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_charge"));
    expect(charge?.delta).toBe(0);
  });

  // Paid re-analysis is a FLAT 1 credit (REANALYSIS_FIXED_CREDIT_COST),
  // not the duration-based first-analysis price. Rationale lives in
  // `lib/credits/pricing.ts`: the transcription service cost is already sunk for
  // the original session, so we only need to cover the LLM provider
  // re-call. A 60-min session would have cost 2 credits the first
  // time; the paid re-run still costs 1.
  it("charges a flat 1 credit when the prior report is older than 24h", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60);
    await db
      .update(schema.interviewSessions)
      .set({ state: "complete" })
      .where(eq(schema.interviewSessions.id, session.id));
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { placeholder: true },
      modelVersion: "test",
      rubricVersion: "test",
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.creditsCharged).toBe(1);
    expect(body.isFreeReanalysis).toBe(false);
    expect(body.balanceAfter).toBe(4);
  });
});

describe("POST /api/sessions/:id/analyze — state machine guard", () => {
  it("returns 409 when the session is in `created`", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
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
    await setBalance(user.id, 5);
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

// H4: a soft-deleted session must look identical to "doesn't exist".
describe("POST /api/sessions/:id/analyze — soft-delete (H4)", () => {
  it("returns 404 for a soft-deleted session", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
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

// C3: in PRODUCTION (`JOB_RUNNER_EVENT_KEY` set), when job runner enqueue
// throws the route MUST roll back the consume — credits restored,
// session state walked back to `review`. There's no inline fallback
// in production: the inline pipeline only fires when the key is unset.
describe("POST /api/sessions/:id/analyze — job runner enqueue failure rolls back consume (C3, production)", () => {
  it("restores the user's credits and walks the session back when enqueue throws", async () => {
    envOverrides.job-runnerEventKey = "test-event-key";
    const user = await seedUser();
    await setBalance(user.id, 5);
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60); // 2 credits

    mockEnqueueAnalyzeSession.mockRejectedValueOnce(new Error("job-runner down"));

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("queue_unavailable");
    expect(body.message).toMatch(/please try again/i);

    // Balance restored to 5.
    const [u] = await db
      .select({ creditBalance: schema.users.creditBalance })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(u?.creditBalance).toBe(5);

    // Session walked back to `review`.
    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("review");

    // Ledger has both the original charge AND the compensating refund.
    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.userId, user.id));
    const charges = ledger.filter((r) => r.reason === "interview_charge");
    const refunds = ledger.filter((r) => r.reason === "interview_refund");
    expect(charges).toHaveLength(1);
    expect(refunds).toHaveLength(1);
    expect(charges[0]?.delta).toBe(-2);
    expect(refunds[0]?.delta).toBe(2);

    // Inline fallback NEVER runs in production.
    expect(mockRunAnalyzeInline).not.toHaveBeenCalled();
  });

  it("free re-analysis: enqueue failure walks state back to `complete`, no balance change", async () => {
    envOverrides.job-runnerEventKey = "test-event-key";
    const user = await seedUser();
    await setBalance(user.id, 0);
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60);
    await db
      .update(schema.interviewSessions)
      .set({ state: "complete" })
      .where(eq(schema.interviewSessions.id, session.id));
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { placeholder: true },
      modelVersion: "test",
      rubricVersion: "test",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    mockEnqueueAnalyzeSession.mockRejectedValueOnce(new Error("job-runner down"));

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(502);

    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("complete");
  });
});

// Dev fallback: when `JOB_RUNNER_EVENT_KEY` is unset and job runner is
// unreachable, the route fires the inline pipeline in the BACKGROUND
// (no await) and returns 202 immediately. The session stays in
// `analyzing`; the inline helper takes over completion (or failure +
// refund) out-of-band, and the detail page's analyzing-poller picks
// up the resulting state.
//
// Awaiting the inline pipeline was making the analyze POST block for
// the full LLM call (~2-3 minutes for behavioural rounds), which
// candidates experienced as a frozen "Starting analysis…" button.
describe("POST /api/sessions/:id/analyze — dev fire-and-forget fallback", () => {
  it("returns 202 immediately, leaves the session in `analyzing`, and invokes the inline helper in the background", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60); // 2 credits

    mockEnqueueAnalyzeSession.mockRejectedValueOnce(new Error("job-runner down"));

    // Resolver pattern so we can assert the helper was invoked AFTER
    // the route already returned, without racing against the
    // `void (async () => …)()` fire-and-forget.
    let inlineCalledArgs: unknown = null;
    let resolveInline!: () => void;
    const inlineCalled = new Promise<void>((resolve) => {
      resolveInline = resolve;
    });
    mockRunAnalyzeInline.mockImplementationOnce(async (args) => {
      inlineCalledArgs = args;
      resolveInline();
      return {
        reportId: "00000000-0000-4000-8000-000000000001",
        modelVersion: "placeholder@dev",
        rubricVersion: "v1",
      };
    });

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.creditsCharged).toBe(2);
    expect(body.isFreeReanalysis).toBe(false);

    // Credits stay debited; the inline helper owns the eventual
    // refund-on-failure path. No route-level rollback rows.
    const [u] = await db
      .select({ creditBalance: schema.users.creditBalance })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(u?.creditBalance).toBe(3);

    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.userId, user.id));
    expect(ledger.filter((r) => r.reason === "interview_charge")).toHaveLength(
      1,
    );
    expect(ledger.filter((r) => r.reason === "interview_refund")).toHaveLength(
      0,
    );

    // Session is in `analyzing` — the inline helper hasn't claimed
    // it for `complete` yet (and in this test the helper is mocked,
    // so it never will). The detail page's poller is what eventually
    // surfaces the state transition.
    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("analyzing");

    // The route DID hand off to the inline helper, just out-of-band.
    await inlineCalled;
    expect(inlineCalledArgs).toEqual({
      sessionId: session.id,
      userId: user.id,
      isFreeReanalysis: false,
      creditsCharged: 2,
    });
  });
});

// One-free-re-run-per-session rule. The free slot is signaled by an
// `interview_charge` ledger row with delta=0 and the session id; once
// such a row exists, the route MUST charge full price on every
// subsequent re-analysis (and the consume invariant rejects any further
// delta=0 attempt as defense in depth).
describe("POST /api/sessions/:id/analyze — one free re-run per session", () => {
  // Paid re-runs are a flat 1 credit (REANALYSIS_FIXED_CREDIT_COST),
  // not the duration-based first-analysis price — see the docstring
  // on the helper in `lib/credits/pricing.ts`.
  it("falls back to the flat 1-credit paid price when the session already has a delta=0 charge (free re-run already used)", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60);
    await db
      .update(schema.interviewSessions)
      .set({ state: "complete" })
      .where(eq(schema.interviewSessions.id, session.id));

    // Recent report → 24h window is still open.
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { initial: true },
      modelVersion: "test",
      rubricVersion: "test",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // Ledger: the original paid charge AND the free re-run that
    // already landed. The next re-analysis must be paid.
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: -2,
      balanceAfter: 5,
      reason: "interview_charge",
      relatedSessionId: session.id,
      createdAt: new Date(Date.now() - 90 * 60 * 1000),
    });
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 0,
      balanceAfter: 5,
      reason: "interview_charge",
      relatedSessionId: session.id,
      createdAt: new Date(Date.now() - 30 * 60 * 1000),
    });

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.isFreeReanalysis).toBe(false);
    expect(body.creditsCharged).toBe(1);
    expect(body.balanceAfter).toBe(4);
    expect(mockEnqueueAnalyzeSession).toHaveBeenCalledWith({
      sessionId: session.id,
      userId: user.id,
      isFreeReanalysis: false,
      creditsCharged: 1,
    });
  });

  it("returns 402 when the free re-run was already used and the user can't afford the paid re-analysis", async () => {
    const user = await seedUser();
    await setBalance(user.id, 0);
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60);
    await db
      .update(schema.interviewSessions)
      .set({ state: "complete" })
      .where(eq(schema.interviewSessions.id, session.id));

    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { initial: true },
      modelVersion: "test",
      rubricVersion: "test",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 0,
      balanceAfter: 0,
      reason: "interview_charge",
      relatedSessionId: session.id,
      createdAt: new Date(Date.now() - 30 * 60 * 1000),
    });

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("insufficient_credits");
    // Paid re-runs cost a flat 1 credit, not the duration-based price.
    expect(body.required).toBe(1);
    expect(mockEnqueueAnalyzeSession).not.toHaveBeenCalled();
  });

  it("does NOT charge for the free re-run when the prior analysis is paid-only (no delta=0 row yet)", async () => {
    const user = await seedUser();
    await setBalance(user.id, 0);
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60);
    await db
      .update(schema.interviewSessions)
      .set({ state: "complete" })
      .where(eq(schema.interviewSessions.id, session.id));

    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { initial: true },
      modelVersion: "test",
      rubricVersion: "test",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    // Only a PAID prior charge — the free slot is still available.
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: -2,
      balanceAfter: 0,
      reason: "interview_charge",
      relatedSessionId: session.id,
      createdAt: new Date(Date.now() - 90 * 60 * 1000),
    });

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.isFreeReanalysis).toBe(true);
    expect(body.creditsCharged).toBe(0);

    // Exactly one delta=0 row landed (the new free re-run).
    const charges = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_charge"));
    expect(charges.filter((c) => c.delta === 0)).toHaveLength(1);
  });

  it("falls back to the flat 1-credit paid charge when the prior analysis is older than 24h, even with no prior free re-run", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
    mockGetActiveUserId.mockResolvedValue(user.id);
    const session = await seedSessionInReview(user.id, 60 * 60);
    await db
      .update(schema.interviewSessions)
      .set({ state: "complete" })
      .where(eq(schema.interviewSessions.id, session.id));

    // Stale report — past the 24h free window.
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { stale: true },
      modelVersion: "test",
      rubricVersion: "test",
      createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
    });

    const res = await POST(post(session.id), buildRoute(session.id));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.isFreeReanalysis).toBe(false);
    expect(body.creditsCharged).toBe(1);
    expect(body.balanceAfter).toBe(4);
  });
});

// M4: defense-in-depth body-size cap.
describe("POST /api/sessions/:id/analyze — body size cap (M4)", () => {
  it("returns 413 when content-length exceeds the cap", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
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
