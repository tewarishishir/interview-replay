/**
 * Integration tests for `/api/rebuilds` (POST/GET) and the
 * `/api/rebuilds/:id` (GET/PATCH/DELETE) routes.
 *
 * These cover the spec's load-bearing edges:
 *   - Auth + same-origin gates
 *   - Ownership: `getRebuild` / `listRebuilds` filter by user id
 *   - Source-session validation: must be owned by caller AND
 *     in state='complete'
 *   - PATCH body length caps (delegated to zod, but smoke-tested
 *     here so a route-level regression doesn't slip through)
 *   - DELETE flips status to 'discarded' (soft delete; the
 *     retention cron purges 30 days later)
 *
 * Out-of-scope here:
 *   - The critique route (covered by guardrails + rate-gate tests)
 *   - Save-to-bank (covered by save-to-bank.test.ts)
 *   - Rate limiting bursts (covered by rate-limit.test.ts)
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

import type * as RateLimitModule from "@/lib/rate-limit";

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

// Stub the rate limiter so unit tests don't need the rate limiter. The
// limit logic itself is covered by `tests/auth/rate-limit.test.ts`.
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>(
    "@/lib/rate-limit",
  );
  const limiter = {
    check: async () => ({
      success: true,
      limit: 1000,
      remaining: 999,
      reset: Date.now() + 60_000,
    }),
    recordFailure: async () => {},
  };
  return {
    ...actual,
    rebuildWriteLimiter: () => limiter,
    rebuildCritiqueLimiter: () => limiter,
  };
});

import {
  GET as listRoute,
  POST as createRoute,
} from "@/app/api/rebuilds/route";
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/rebuilds/[id]/route";
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

async function seedCompleteSession(userId: string): Promise<string> {
  const created = await createSession({
    userId,
    companyName: "Acme",
    roleTitle: "Engineer",
    level: "senior",
    roundType: "behavioral",
    scheduledAt: null,
  });
  await db
    .update(schema.interviewSessions)
    .set({ state: "complete" })
    .where(eq(schema.interviewSessions.id, created.id));
  return created.id;
}

async function postCreate(body: Record<string, unknown>): Promise<Response> {
  return createRoute(
    new Request("http://localhost:3000/api/rebuilds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function getList(query = ""): Promise<Response> {
  return listRoute(
    new Request(`http://localhost:3000/api/rebuilds${query}`, {
      method: "GET",
    }),
  );
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/rebuilds", () => {
  it("401 when not signed in", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const r = await postCreate({ question_text: "x" });
    expect(r.status).toBe(401);
  });

  it("403 on cross-origin request", async () => {
    mockGetActiveUserId.mockResolvedValue("u-1");
    setHeaders({ ...DEFAULT_HEADERS, origin: "https://evil.example" });
    const r = await postCreate({ question_text: "x" });
    expect(r.status).toBe(403);
  });

  it("creates a rebuild with a minimal valid body", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const r = await postCreate({
      question_text: "Tell me about a tough call.",
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { rebuild: { id: string; status: string } };
    expect(body.rebuild.status).toBe("in_progress");

    const rows = await db.select().from(schema.storyRebuilds);
    expect(rows).toHaveLength(1);
  });

  it("400 when source_improvement_index has no source_session_id", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const r = await postCreate({
      question_text: "x",
      source_improvement_index: 1,
    });
    expect(r.status).toBe(400);
  });

  it("rejects a source_session_id that doesn't belong to the user", async () => {
    const owner = await seedUser("owner@example.com");
    const sessionId = await seedCompleteSession(owner.id);
    const attacker = await seedUser("attacker@example.com");
    mockGetActiveUserId.mockResolvedValue(attacker.id);

    const r = await postCreate({
      question_text: "x",
      source_session_id: sessionId,
    });
    expect([400, 404]).toContain(r.status);
  });

  it("rejects a source_session_id whose state is not 'complete'", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);

    // Seed a session and leave it in default state (which is NOT complete).
    const created = await createSession({
      userId: u.id,
      companyName: "Acme",
      roleTitle: "Engineer",
      level: "senior",
      roundType: "behavioral",
      scheduledAt: null,
    });

    const r = await postCreate({
      question_text: "x",
      source_session_id: created.id,
    });
    expect([400, 409]).toContain(r.status);
  });
});

describe("GET /api/rebuilds", () => {
  it("only returns rebuilds owned by the caller", async () => {
    const me = await seedUser("me@example.com");
    const them = await seedUser("them@example.com");

    await db.insert(schema.storyRebuilds).values({
      userId: me.id,
      questionText: "mine",
    });
    await db.insert(schema.storyRebuilds).values({
      userId: them.id,
      questionText: "theirs",
    });

    mockGetActiveUserId.mockResolvedValue(me.id);
    const r = await getList();
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      rebuilds: Array<{ questionText: string }>;
    };
    expect(body.rebuilds).toHaveLength(1);
    expect(body.rebuilds[0]!.questionText).toBe("mine");
  });

  it("excludes discarded rebuilds by default", async () => {
    const u = await seedUser();
    await db.insert(schema.storyRebuilds).values([
      { userId: u.id, questionText: "live" },
      { userId: u.id, questionText: "gone", status: "discarded" },
    ]);
    mockGetActiveUserId.mockResolvedValue(u.id);
    const r = await getList();
    const body = (await r.json()) as {
      rebuilds: Array<{ questionText: string }>;
    };
    expect(body.rebuilds.map((r) => r.questionText)).toEqual(["live"]);
  });
});

describe("GET / PATCH / DELETE /api/rebuilds/:id", () => {
  it("returns 404 for a rebuild owned by another user", async () => {
    const owner = await seedUser("owner@example.com");
    const attacker = await seedUser("attacker@example.com");
    const [row] = await db
      .insert(schema.storyRebuilds)
      .values({ userId: owner.id, questionText: "secret" })
      .returning();
    mockGetActiveUserId.mockResolvedValue(attacker.id);

    const get = await getRoute(
      new Request(`http://localhost:3000/api/rebuilds/${row!.id}`, {
        method: "GET",
      }),
      paramsFor(row!.id),
    );
    expect(get.status).toBe(404);

    const patch = await patchRoute(
      new Request(`http://localhost:3000/api/rebuilds/${row!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headline: "hijack" }),
      }),
      paramsFor(row!.id),
    );
    expect(patch.status).toBe(404);

    const del = await deleteRoute(
      new Request(`http://localhost:3000/api/rebuilds/${row!.id}`, {
        method: "DELETE",
      }),
      paramsFor(row!.id),
    );
    expect(del.status).toBe(404);
  });

  it("PATCH updates only the supplied fields", async () => {
    const u = await seedUser();
    const [row] = await db
      .insert(schema.storyRebuilds)
      .values({ userId: u.id, questionText: "q" })
      .returning();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await patchRoute(
      new Request(`http://localhost:3000/api/rebuilds/${row!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headline: "Drove the migration",
          situation: "We had a 90-day mandate",
        }),
      }),
      paramsFor(row!.id),
    );
    expect(r.status).toBe(200);

    const [fresh] = await db
      .select()
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.id, row!.id));
    expect(fresh!.headline).toBe("Drove the migration");
    expect(fresh!.situation).toBe("We had a 90-day mandate");
    expect(fresh!.task).toBeNull();
  });

  it("PATCH rejects oversized fields", async () => {
    const u = await seedUser();
    const [row] = await db
      .insert(schema.storyRebuilds)
      .values({ userId: u.id, questionText: "q" })
      .returning();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await patchRoute(
      new Request(`http://localhost:3000/api/rebuilds/${row!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ situation: "x".repeat(2001) }),
      }),
      paramsFor(row!.id),
    );
    expect(r.status).toBe(400);
  });

  it("DELETE flips status to 'discarded' (soft delete)", async () => {
    const u = await seedUser();
    const [row] = await db
      .insert(schema.storyRebuilds)
      .values({ userId: u.id, questionText: "q" })
      .returning();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await deleteRoute(
      new Request(`http://localhost:3000/api/rebuilds/${row!.id}`, {
        method: "DELETE",
      }),
      paramsFor(row!.id),
    );
    expect([200, 204]).toContain(r.status);

    const [fresh] = await db
      .select()
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.id, row!.id));
    expect(fresh!.status).toBe("discarded");
  });

  it("DELETE is idempotent on an already-discarded rebuild", async () => {
    const u = await seedUser();
    const [row] = await db
      .insert(schema.storyRebuilds)
      .values({ userId: u.id, questionText: "q", status: "discarded" })
      .returning();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await deleteRoute(
      new Request(`http://localhost:3000/api/rebuilds/${row!.id}`, {
        method: "DELETE",
      }),
      paramsFor(row!.id),
    );
    expect([200, 204]).toContain(r.status);
  });

  it("DELETE refuses to discard a saved_to_bank rebuild (would orphan the audit trail)", async () => {
    const u = await seedUser();
    const [row] = await db
      .insert(schema.storyRebuilds)
      .values({
        userId: u.id,
        questionText: "q",
        status: "saved_to_bank",
        headline: "h",
        situation: "s",
      })
      .returning();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await deleteRoute(
      new Request(`http://localhost:3000/api/rebuilds/${row!.id}`, {
        method: "DELETE",
      }),
      paramsFor(row!.id),
    );
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("rebuild_wrong_state");

    const [fresh] = await db
      .select()
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.id, row!.id));
    expect(fresh!.status).toBe("saved_to_bank");
  });

  it("PATCH refuses to mutate a saved_to_bank rebuild (would diverge from the promoted story)", async () => {
    const u = await seedUser();
    const [row] = await db
      .insert(schema.storyRebuilds)
      .values({
        userId: u.id,
        questionText: "q",
        status: "saved_to_bank",
        headline: "original",
      })
      .returning();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await patchRoute(
      new Request(`http://localhost:3000/api/rebuilds/${row!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headline: "smuggled rewrite" }),
      }),
      paramsFor(row!.id),
    );
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("rebuild_wrong_state");

    const [fresh] = await db
      .select()
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.id, row!.id));
    expect(fresh!.headline).toBe("original");
  });

  it("PATCH refuses to mutate a discarded rebuild (would resurrect a soft-delete)", async () => {
    const u = await seedUser();
    const [row] = await db
      .insert(schema.storyRebuilds)
      .values({
        userId: u.id,
        questionText: "q",
        status: "discarded",
      })
      .returning();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await patchRoute(
      new Request(`http://localhost:3000/api/rebuilds/${row!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headline: "I'm back" }),
      }),
      paramsFor(row!.id),
    );
    expect(r.status).toBe(409);
  });
});

/* ──────────────────────────────────────────────────────────── */
/* Idempotency on POST /api/rebuilds                             */
/* ──────────────────────────────────────────────────────────── */

describe("POST /api/rebuilds — idempotency", () => {
  it("returns the existing in_progress rebuild for the same (session, improvement_index) pair", async () => {
    const u = await seedUser();
    const sessionId = await seedCompleteSession(u.id);
    mockGetActiveUserId.mockResolvedValue(u.id);

    const first = await postCreate({
      question_text: "Tell me about a tough call.",
      source_session_id: sessionId,
      source_improvement_index: 2,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      rebuild: { id: string; status: string };
    };

    // Second click with the same payload should return the same
    // rebuild row, not create a duplicate.
    const second = await postCreate({
      question_text: "Tell me about a tough call.",
      source_session_id: sessionId,
      source_improvement_index: 2,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      rebuild: { id: string };
    };
    expect(secondBody.rebuild.id).toBe(firstBody.rebuild.id);

    const all = await db
      .select()
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.userId, u.id));
    expect(all).toHaveLength(1);
  });

  it("does NOT dedupe across different improvement indexes", async () => {
    const u = await seedUser();
    const sessionId = await seedCompleteSession(u.id);
    mockGetActiveUserId.mockResolvedValue(u.id);

    const a = await postCreate({
      question_text: "first improvement",
      source_session_id: sessionId,
      source_improvement_index: 0,
    });
    const b = await postCreate({
      question_text: "second improvement",
      source_session_id: sessionId,
      source_improvement_index: 1,
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const rows = await db
      .select()
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.userId, u.id));
    expect(rows).toHaveLength(2);
  });

  it("does NOT dedupe across users (per-user idempotency only)", async () => {
    const a = await seedUser("a@example.com");
    const b = await seedUser("b@example.com");
    const sessionA = await seedCompleteSession(a.id);
    const sessionB = await seedCompleteSession(b.id);

    mockGetActiveUserId.mockResolvedValue(a.id);
    await postCreate({
      question_text: "x",
      source_session_id: sessionA,
      source_improvement_index: 0,
    });
    mockGetActiveUserId.mockResolvedValue(b.id);
    await postCreate({
      question_text: "x",
      source_session_id: sessionB,
      source_improvement_index: 0,
    });

    const rows = await db.select().from(schema.storyRebuilds);
    expect(rows).toHaveLength(2);
  });

  it("creates a fresh rebuild after the previous one was critiqued (user explicitly opted into a redo)", async () => {
    const u = await seedUser();
    const sessionId = await seedCompleteSession(u.id);
    mockGetActiveUserId.mockResolvedValue(u.id);

    const first = await postCreate({
      question_text: "x",
      source_session_id: sessionId,
      source_improvement_index: 0,
    });
    const firstId = (await first.json()).rebuild.id;

    // Simulate the user critiquing → status flips off in_progress.
    await db
      .update(schema.storyRebuilds)
      .set({ status: "critiqued" })
      .where(eq(schema.storyRebuilds.id, firstId));

    const second = await postCreate({
      question_text: "x",
      source_session_id: sessionId,
      source_improvement_index: 0,
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { rebuild: { id: string } };
    expect(secondBody.rebuild.id).not.toBe(firstId);
  });
});
