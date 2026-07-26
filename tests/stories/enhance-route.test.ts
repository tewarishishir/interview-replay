/**
 * Integration tests for `POST /api/stories/enhance`.
 *
 * What we cover:
 *   - 401 when not authenticated.
 *   - 403 when cross-origin.
 *   - 400 on invalid body (missing critique field).
 *   - 429 from the per-user 10/24h content gate — verifying that both
 *     story_critique.unit_charged AND story_enhance.unit_charged events
 *     count toward the combined 10/24h budget.
 *   - 402 when balance=0 and units at the rollover boundary —
 *     LLM call is skipped (preflight short-circuit).
 *   - 200 + creditsCharged=0 on a non-rollover enhance that bumps the
 *     accumulator without touching the balance.
 *   - 200 + creditsCharged=1 when the Nth enhance rolls over, plus a
 *     `rebuild_critique_charge` ledger row.
 *   - Audit row: `story_enhance.unit_charged` is written on success.
 *   - Success response shape: `enhanced` contains the rewritten fields.
 *
 * The `runStoryEnhance` helper is stubbed so the tests don't need an
 * LLM provider API key. Credit/accumulator logic runs against a real
 * Postgres instance.
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
import { and, eq, sql } from "drizzle-orm";

import type * as RateLimitModule from "@/lib/rate-limit";
import type * as StoriesModule from "@/lib/stories";
import type {
  CritiqueResponse,
  DimensionFeedback,
} from "@/lib/rebuilds/schemas";

/* ─── next/headers + auth mocks ────────────────────────────── */

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

/* ─── Rate-limit mock — always allow by default ─────────────── */

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
    rebuildCritiqueLimiter: () => limiter,
  };
});

/* ─── Stub the LLM round-trip ────────────────────────────────── */

const buildPassingDim = (
  dimension: DimensionFeedback["dimension"],
): DimensionFeedback => ({
  dimension,
  status: "strong",
  quoted_excerpt: "",
  what_to_check: "ok",
});

const passingDimensions: DimensionFeedback[] = [
  buildPassingDim("headline"),
  buildPassingDim("star_completeness"),
  buildPassingDim("first_person"),
  buildPassingDim("quantification"),
  buildPassingDim("profile_consistency"),
  buildPassingDim("profile_leverage"),
];

const passingCritique: CritiqueResponse = {
  overall_assessment: "Solid story.",
  dimension_feedback: passingDimensions,
  next_step_suggestion: "Tighten the result.",
};

const ENHANCED_DRAFT = {
  situation: "Enhanced situation text.",
  task: "Enhanced task text.",
  action: "Enhanced action text.",
  result: "Enhanced result text.",
  what_i_learned: "Enhanced learned text.",
};

vi.mock("@/lib/stories", async () => {
  const actual = await vi.importActual<typeof StoriesModule>("@/lib/stories");
  return {
    ...actual,
    runStoryEnhance: async () => ({
      enhanced: ENHANCED_DRAFT,
      modelVersion: "test-model",
      promptVersion: "test-prompt",
    }),
  };
});

/* ─── Imports after mocks ─────────────────────────────────────── */

import { POST as storyEnhanceRoute } from "@/app/api/stories/enhance/route";
import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import {
  REBUILD_CRITIQUE_UNITS_PER_CREDIT,
} from "@/lib/credits";
import {
  STORY_CRITIQUE_AUDIT_EVENT_TYPE,
  STORY_CRITIQUE_DAILY_CAP,
  STORY_ENHANCE_AUDIT_EVENT_TYPE,
} from "@/lib/stories";

import { ensureSchema, resetDatabase } from "../db/helpers";

/* ─── Setup / teardown ───────────────────────────────────────── */

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

/* ─── Helpers ────────────────────────────────────────────────── */

const seedUser = async (email = "alice@example.com") => {
  const r = await createCredentialsUser({
    email,
    password: "password123",
    name: "Alice",
  });
  if (!r.ok) throw new Error(`seedUser failed: ${r.error}`);
  return r.user;
};

const setBalanceAndUnits = async (
  userId: string,
  balance: number,
  units: number,
) => {
  await db
    .update(schema.users)
    .set({ creditBalance: balance, rebuildCritiqueUnits: units })
    .where(eq(schema.users.id, userId));
};

const readUser = async (userId: string) => {
  const [row] = await db
    .select({
      creditBalance: schema.users.creditBalance,
      rebuildCritiqueUnits: schema.users.rebuildCritiqueUnits,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!row) throw new Error(`readUser: ${userId} not found`);
  return row;
};

const countLedgerCharges = async (userId: string) => {
  const rows = await db
    .select()
    .from(schema.creditTransactions)
    .where(eq(schema.creditTransactions.userId, userId));
  return rows.filter((r) => r.reason === "rebuild_critique_charge").length;
};

/** Insert N audit rows of the given event type. */
const seedAuditRows = async (
  userId: string,
  count: number,
  eventType: string,
) => {
  for (let i = 0; i < count; i++) {
    await db.insert(schema.auditLog).values({
      userId,
      eventType,
      eventData: { creditCost: 0.2 },
    });
  }
};

const VALID_BODY = {
  title: "I drove a latency cut.",
  situation: "We were on a 90-day mandate to cut latency.",
  task: "I owned the cutover plan.",
  action: "I shipped the rollout in phased flags.",
  result: "Latency dropped 38% within the quarter.",
  whatILearned: "Incremental deploys reduce blast radius.",
  critique: passingCritique,
};

const callRoute = (body: unknown = VALID_BODY) =>
  storyEnhanceRoute(
    new Request("http://localhost:3000/api/stories/enhance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/* ─── Auth + same-origin tests ───────────────────────────────── */

describe("POST /api/stories/enhance — auth", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const r = await callRoute();
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("returns 403 for cross-origin requests", async () => {
    setHeaders({ origin: "https://evil.example.com" });
    const r = await callRoute();
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });
});

/* ─── Body validation tests ──────────────────────────────────── */

describe("POST /api/stories/enhance — validation", () => {
  it("returns 400 when critique is missing", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const { critique: _omit, ...bodyWithoutCritique } = VALID_BODY;
    const r = await callRoute(bodyWithoutCritique);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_body");
  });

  it("returns 400 when critique is malformed", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const r = await callRoute({ ...VALID_BODY, critique: { bad: "shape" } });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_body");
  });
});

/* ─── Rate-limiting tests ─────────────────────────────────────── */

describe("POST /api/stories/enhance — rate limiting", () => {
  it("returns 429 when the per-user 10/24h cap is full (via critique events)", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    await seedAuditRows(u.id, STORY_CRITIQUE_DAILY_CAP, STORY_CRITIQUE_AUDIT_EVENT_TYPE);

    const r = await callRoute();
    expect(r.status).toBe(429);
    const body = (await r.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfter).toBe("number");
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it("returns 429 when cap is full via a mix of critique and enhance events", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    // 5 critiques + 5 enhances = 10 total (at cap)
    await seedAuditRows(u.id, 5, STORY_CRITIQUE_AUDIT_EVENT_TYPE);
    await seedAuditRows(u.id, 5, STORY_ENHANCE_AUDIT_EVENT_TYPE);

    const r = await callRoute();
    expect(r.status).toBe(429);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });

  it("allows an enhance when the combined cap is not yet reached", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    // 9 events total = one below the cap
    await seedAuditRows(u.id, STORY_CRITIQUE_DAILY_CAP - 1, STORY_CRITIQUE_AUDIT_EVENT_TYPE);

    const r = await callRoute();
    expect(r.status).toBe(200);
  });
});

/* ─── Credit charging tests ──────────────────────────────────── */

describe("POST /api/stories/enhance — credit charging", () => {
  it("returns 402 BEFORE the LLM call when balance=0 and units at rollover boundary", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    await setBalanceAndUnits(u.id, 0, REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1);

    const r = await callRoute();
    expect(r.status).toBe(402);
    const body = (await r.json()) as { error: string; perCritiqueCost: number };
    expect(body.error).toBe("insufficient_credits");

    // Accumulator + balance must not have moved.
    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(0);
    expect(after.rebuildCritiqueUnits).toBe(REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1);
    expect(await countLedgerCharges(u.id)).toBe(0);
  });

  it("non-rollover enhance returns 200 with creditsCharged=0 and bumps the accumulator", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = (await readUser(u.id)).creditBalance;
    await setBalanceAndUnits(u.id, startingBalance, 0);

    const r = await callRoute();
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      creditsCharged: number;
      balanceAfter: number | null;
    };
    expect(body.creditsCharged).toBe(0);
    expect(body.balanceAfter).toBe(startingBalance);

    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(startingBalance);
    expect(after.rebuildCritiqueUnits).toBe(1);
    expect(await countLedgerCharges(u.id)).toBe(0);
  });

  it("rollover enhance returns 200 with creditsCharged=1 and writes a ledger row", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = 5;
    await setBalanceAndUnits(
      u.id,
      startingBalance,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );

    const r = await callRoute();
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      creditsCharged: number;
      balanceAfter: number | null;
    };
    expect(body.creditsCharged).toBe(1);
    expect(body.balanceAfter).toBe(startingBalance - 1);

    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(startingBalance - 1);
    expect(after.rebuildCritiqueUnits).toBe(0);
    expect(await countLedgerCharges(u.id)).toBe(1);
  });
});

/* ─── Success response shape ─────────────────────────────────── */

describe("POST /api/stories/enhance — success path", () => {
  it("returns enhanced fields with correct shape", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await callRoute();
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      enhanced: {
        situation: string;
        task: string;
        action: string;
        result: string;
        whatILearned: string;
      };
      creditsCharged: number;
      balanceAfter: number | null;
    };

    expect(typeof body.enhanced.situation).toBe("string");
    expect(typeof body.enhanced.task).toBe("string");
    expect(typeof body.enhanced.action).toBe("string");
    expect(typeof body.enhanced.result).toBe("string");
    expect(typeof body.enhanced.whatILearned).toBe("string");
    expect(body.enhanced.situation).toBe(ENHANCED_DRAFT.situation);
    expect(body.enhanced.task).toBe(ENHANCED_DRAFT.task);
    expect(body.enhanced.action).toBe(ENHANCED_DRAFT.action);
    expect(body.enhanced.result).toBe(ENHANCED_DRAFT.result);
    expect(typeof body.creditsCharged).toBe("number");
  });

  it("writes a story_enhance.unit_charged audit row on success", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const before = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, u.id),
          eq(schema.auditLog.eventType, STORY_ENHANCE_AUDIT_EVENT_TYPE),
        ),
      )
      .then(([r]) => r?.count ?? 0);

    const response = await callRoute();
    expect(response.status).toBe(200);

    const after = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, u.id),
          eq(schema.auditLog.eventType, STORY_ENHANCE_AUDIT_EVENT_TYPE),
        ),
      )
      .then(([r]) => r?.count ?? 0);

    expect(after).toBe(Number(before) + 1);
  });
});
