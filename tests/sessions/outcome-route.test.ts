/**
 * Integration tests for `/api/sessions/:id/outcome` (POST/GET/PATCH/
 * DELETE) and the underlying outcome helpers.
 *
 * Behaviors per the PRD:
 *   - Requires auth + same-origin.
 *   - Session must exist, be owned by the caller, and be in
 *     `state = complete`.
 *   - POST 409s if an outcome already exists; PATCH/DELETE 404
 *     when no outcome exists yet.
 *   - Body validation: outcome_type is required for POST,
 *     length caps on the three free-text fields, ISO8601 date.
 *   - `next_round_type` is silently dropped for outcome types
 *     other than `advanced_to_next_round`.
 *   - Each write writes one audit log entry; the body NEVER
 *     contains the user's free-text values.
 *
 * The Drizzle layer hits real Postgres so the unique-violation
 * race protection and the ownership predicate stay honest.
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

import {
  DELETE as outcomeDeleteRoute,
  GET as outcomeGetRoute,
  PATCH as outcomePatchRoute,
  POST as outcomePostRoute,
} from "@/app/api/sessions/[id]/outcome/route";
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
  setHeaders(null);
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

interface SeededComplete {
  userId: string;
  sessionId: string;
}

/**
 * Walks a session straight to `state = complete`. The route only
 * needs the state column to be `complete` and the session to be
 * owned by the caller — we don't need the upstream transcript /
 * audio / report rows for the outcome route to do its thing.
 */
const seedComplete = async (
  email = "alice@example.com",
): Promise<SeededComplete> => {
  const user = await seedUser(email);
  const row = await createSession({
    userId: user.id,
    companyName: "Stripe",
    roleTitle: "Senior Backend Engineer",
    level: "senior",
    roundType: "system_design",
    scheduledAt: null,
  });
  await db
    .update(schema.interviewSessions)
    .set({ state: "complete" })
    .where(eq(schema.interviewSessions.id, row.id));
  return { userId: user.id, sessionId: row.id };
};

const ctx = (params: { id: string }) =>
  ({
    params: Promise.resolve(params),
  }) as { params: Promise<{ id: string }> };

const buildJsonRequest = (
  method: string,
  url: string,
  body?: unknown,
): Request =>
  new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
    },
    body: body === undefined ? null : JSON.stringify(body),
  });

const url = (sessionId: string) =>
  `http://localhost:3000/api/sessions/${sessionId}/outcome`;

/* ──────────────────────────────────────────────────────────── */
/*                              POST                             */
/* ──────────────────────────────────────────────────────────── */

describe("POST /api/sessions/:id/outcome", () => {
  it("creates an outcome with the full set of fields", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    // dateNullable schema allows up to +24 h; use +1 h so we're after session
    // creation (cross-field check) but within the schema's tomorrow ceiling.
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "received_offer",
        outcome_received_at: futureDate,
        feedback_received: "They loved the system design walkthrough.",
        reflection_notes: "I felt confident after question 2.",
        would_change: "Push back earlier on the latency assumption.",
      }),
      ctx({ id: sessionId }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { outcome: Record<string, unknown> };
    expect(body.outcome.outcomeType).toBe("received_offer");
    expect(body.outcome.feedbackReceived).toBe(
      "They loved the system design walkthrough.",
    );
    expect(body.outcome.outcomeReceivedAt).toBe(futureDate);

    // Audit log: one row, payload contains booleans not text.
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    const recorded = audit.find((r) => r.eventType === "outcome.recorded");
    expect(recorded).toBeDefined();
    const data = recorded!.eventData as Record<string, unknown>;
    expect(data.sessionId).toBe(sessionId);
    expect(data.outcomeType).toBe("received_offer");
    expect(data.hasFeedbackReceived).toBe(true);
    expect(data.hasReflectionNotes).toBe(true);
    expect(data.hasWouldChange).toBe(true);
    expect(data.hasOutcomeReceivedAt).toBe(true);
    // Critical: the audit log MUST NOT contain the free-text content.
    const dataStr = JSON.stringify(data);
    expect(dataStr).not.toContain("system design walkthrough");
    expect(dataStr).not.toContain("latency assumption");
  });

  it("strips next_round_type when the outcome is not advanced_to_next_round", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "did_not_advance",
        next_round_type: "Final round with VP", // should be ignored
      }),
      ctx({ id: sessionId }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { outcome: Record<string, unknown> };
    expect(body.outcome.nextRoundType).toBe(null);
  });

  it("preserves next_round_type when advancing to the next round", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "advanced_to_next_round",
        next_round_type: "Onsite loop",
      }),
      ctx({ id: sessionId }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { outcome: Record<string, unknown> };
    expect(body.outcome.nextRoundType).toBe("Onsite loop");
  });

  it("returns 409 when an outcome already exists for the session", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    const first = await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "did_not_advance",
      }),
      ctx({ id: sessionId }),
    );
    expect(first.status).toBe(201);

    const second = await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "received_offer",
      }),
      ctx({ id: sessionId }),
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("outcome_already_exists");
  });

  it("returns 409 when the session is not in `complete` state", async () => {
    const user = await seedUser();
    const row = await createSession({
      userId: user.id,
      companyName: "Stripe",
      roleTitle: "Senior Backend Engineer",
      level: "senior",
      roundType: "coding",
      scheduledAt: null,
    });
    // Leave it in `created`.
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await outcomePostRoute(
      buildJsonRequest("POST", url(row.id), {
        outcome_type: "did_not_advance",
      }),
      ctx({ id: row.id }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      currentState: string;
    };
    expect(body.error).toBe("state_conflict");
    expect(body.currentState).toBe("created");
  });

  it("returns 401 when not signed in", async () => {
    const { sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(null);

    const res = await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "did_not_advance",
      }),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the session belongs to another user", async () => {
    const { sessionId } = await seedComplete("alice@example.com");
    const bob = await seedUser("bob@example.com");
    mockGetActiveUserId.mockResolvedValue(bob.id);

    const res = await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "received_offer",
      }),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects an invalid outcome_type", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "ghosted_after_offer",
      }),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe("validation_failed");
    expect(body.fieldErrors.outcome_type).toBeDefined();
  });

  it("rejects when feedback_received exceeds the cap", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "did_not_advance",
        feedback_received: "x".repeat(5001),
      }),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(400);
  });
});

/* ──────────────────────────────────────────────────────────── */
/*                              GET                              */
/* ──────────────────────────────────────────────────────────── */

describe("GET /api/sessions/:id/outcome", () => {
  it("returns the outcome when one exists", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "advanced_to_next_round",
        next_round_type: "Onsite loop",
      }),
      ctx({ id: sessionId }),
    );

    const res = await outcomeGetRoute(
      new Request(url(sessionId), {
        headers: { origin: "http://localhost:3000" },
      }),
      ctx({ id: sessionId }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: Record<string, unknown> };
    expect(body.outcome.outcomeType).toBe("advanced_to_next_round");
    expect(body.outcome.nextRoundType).toBe("Onsite loop");
  });

  it("returns 404 when no outcome has been recorded", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await outcomeGetRoute(
      new Request(url(sessionId), {
        headers: { origin: "http://localhost:3000" },
      }),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the session belongs to someone else", async () => {
    const { userId, sessionId } = await seedComplete("alice@example.com");
    mockGetActiveUserId.mockResolvedValue(userId);
    await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "received_offer",
      }),
      ctx({ id: sessionId }),
    );

    const bob = await seedUser("bob@example.com");
    mockGetActiveUserId.mockResolvedValue(bob.id);

    const res = await outcomeGetRoute(
      new Request(url(sessionId), {
        headers: { origin: "http://localhost:3000" },
      }),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(404);
  });
});

/* ──────────────────────────────────────────────────────────── */
/*                             PATCH                             */
/* ──────────────────────────────────────────────────────────── */

describe("PATCH /api/sessions/:id/outcome", () => {
  it("updates the supplied fields and leaves the rest alone", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "did_not_advance",
        feedback_received: "Original feedback",
      }),
      ctx({ id: sessionId }),
    );

    const res = await outcomePatchRoute(
      buildJsonRequest("PATCH", url(sessionId), {
        would_change: "Speak more slowly during behavioral.",
      }),
      ctx({ id: sessionId }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: Record<string, unknown> };
    expect(body.outcome.outcomeType).toBe("did_not_advance");
    expect(body.outcome.feedbackReceived).toBe("Original feedback");
    expect(body.outcome.wouldChange).toBe(
      "Speak more slowly during behavioral.",
    );

    // Audit log: one `outcome.updated` row.
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    expect(
      audit.filter((r) => r.eventType === "outcome.updated"),
    ).toHaveLength(1);
  });

  it("changes the outcome type from advanced to received_offer and clears next_round", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "advanced_to_next_round",
        next_round_type: "Onsite loop",
      }),
      ctx({ id: sessionId }),
    );

    const res = await outcomePatchRoute(
      buildJsonRequest("PATCH", url(sessionId), {
        outcome_type: "received_offer",
      }),
      ctx({ id: sessionId }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: Record<string, unknown> };
    expect(body.outcome.outcomeType).toBe("received_offer");
    expect(body.outcome.nextRoundType).toBe(null);
  });

  it("returns 404 when no outcome exists yet", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await outcomePatchRoute(
      buildJsonRequest("PATCH", url(sessionId), {
        feedback_received: "Late update",
      }),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when the PATCH body is empty", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "did_not_advance",
      }),
      ctx({ id: sessionId }),
    );

    const res = await outcomePatchRoute(
      buildJsonRequest("PATCH", url(sessionId), {}),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(400);
  });
});

/* ──────────────────────────────────────────────────────────── */
/*                            DELETE                             */
/* ──────────────────────────────────────────────────────────── */

describe("DELETE /api/sessions/:id/outcome", () => {
  it("removes the outcome and writes an audit row", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "did_not_advance",
      }),
      ctx({ id: sessionId }),
    );

    const res = await outcomeDeleteRoute(
      new Request(url(sessionId), {
        method: "DELETE",
        headers: { origin: "http://localhost:3000" },
      }),
      ctx({ id: sessionId }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      previousOutcomeType: string;
    };
    expect(body.ok).toBe(true);
    expect(body.previousOutcomeType).toBe("did_not_advance");

    // Row is gone.
    const rows = await db
      .select()
      .from(schema.sessionOutcomes)
      .where(eq(schema.sessionOutcomes.sessionId, sessionId));
    expect(rows).toHaveLength(0);

    // Audit row written.
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    expect(
      audit.filter((r) => r.eventType === "outcome.deleted"),
    ).toHaveLength(1);
  });

  it("returns 404 when no outcome existed", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await outcomeDeleteRoute(
      new Request(url(sessionId), {
        method: "DELETE",
        headers: { origin: "http://localhost:3000" },
      }),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(404);
  });
});

/* ──────────────────────────────────────────────────────────── */
/*                       Validation hardening                    */
/* ──────────────────────────────────────────────────────────── */

describe("outcome_received_at sanity bounds", () => {
  it("rejects a date in the far past (year < 2020)", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    const res = await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "received_offer",
        outcome_received_at: "1999-01-01T00:00:00Z",
      }),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe("validation_failed");
    expect(body.fieldErrors.outcome_received_at).toBeDefined();
  });

  it("rejects a date well into the future", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    const fiveYearsOut = new Date(
      Date.now() + 5 * 365 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const res = await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "received_offer",
        outcome_received_at: fiveYearsOut,
      }),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      fieldErrors: Record<string, string>;
    };
    expect(body.fieldErrors.outcome_received_at).toBeDefined();
  });

  it("rejects a date strictly before the session was created", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    // Force the session createdAt to today; record an outcome
    // dated long before that.
    const recentCreate = new Date();
    await db
      .update(schema.interviewSessions)
      .set({ createdAt: recentCreate })
      .where(eq(schema.interviewSessions.id, sessionId));

    const beforeSession = new Date(
      recentCreate.getTime() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const res = await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "received_offer",
        outcome_received_at: beforeSession,
      }),
      ctx({ id: sessionId }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      fieldErrors: Record<string, string>;
    };
    expect(body.fieldErrors.outcome_received_at).toMatch(
      /before the interview/i,
    );
  });
});

describe("PATCH cross-field consistency", () => {
  it("forces next_round_type to null when the persisted outcome_type isn't advanced", async () => {
    // The Zod transform only sees the request body. A user can
    // PATCH `{ next_round_type: "X" }` against a `rejected`
    // outcome and the schema would let it through; the route
    // helper has to clear the field based on the EFFECTIVE
    // (post-update) outcome_type to keep the row consistent.
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "did_not_advance",
      }),
      ctx({ id: sessionId }),
    );

    const res = await outcomePatchRoute(
      buildJsonRequest("PATCH", url(sessionId), {
        next_round_type: "Final round with VP",
      }),
      ctx({ id: sessionId }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: Record<string, unknown> };
    // Persisted outcome is `rejected` → next_round_type MUST be null
    // even though the user supplied a non-null value.
    expect(body.outcome.outcomeType).toBe("did_not_advance");
    expect(body.outcome.nextRoundType).toBe(null);
  });

  it("preserves next_round_type when both the persisted and supplied state are advanced", async () => {
    const { userId, sessionId } = await seedComplete();
    mockGetActiveUserId.mockResolvedValue(userId);

    await outcomePostRoute(
      buildJsonRequest("POST", url(sessionId), {
        outcome_type: "advanced_to_next_round",
        next_round_type: "Onsite loop",
      }),
      ctx({ id: sessionId }),
    );

    const res = await outcomePatchRoute(
      buildJsonRequest("PATCH", url(sessionId), {
        next_round_type: "Onsite + lunch interview",
      }),
      ctx({ id: sessionId }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: Record<string, unknown> };
    expect(body.outcome.outcomeType).toBe("advanced_to_next_round");
    expect(body.outcome.nextRoundType).toBe("Onsite + lunch interview");
  });
});
