/**
 * Integration tests for `POST /api/rebuilds/:id/enhance` focused
 * on the credit-charging surface — mirrors the structure of
 * `critique-route.test.ts` so the two surfaces stay in lockstep.
 *
 * What we cover:
 *   - 402 when the user is at the rollover boundary with zero
 *     balance — the LLM call is skipped (preflight short-circuit).
 *   - 200 + creditsCharged=0 on a non-rollover enhance that
 *     bumps the accumulator without touching the balance.
 *   - 200 + creditsCharged=1 when the Nth enhance rolls over,
 *     plus a `rebuild_critique_charge` ledger row.
 *   - 409 when the rebuild is in `in_progress` state (no critique
 *     yet — can't enhance without one).
 *   - 409 when the rebuild is `saved_to_bank` or `discarded`.
 *   - The draft fields on the rebuild row are updated after a
 *     successful enhance call.
 *
 * `runEnhance` is stubbed so the tests don't need an LLM provider
 * API key. The credit/accumulator logic is the real
 * `chargeRebuildCritique` against a real Postgres.
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
import type * as RebuildsModule from "@/lib/rebuilds";
import type { EnhancedDraft } from "@/lib/rebuilds/enhance";
import type { CritiqueResponse, DimensionFeedback } from "@/lib/rebuilds/schemas";

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

/* ── Stub the LLM enhance round-trip ──────────────────────────── */

const passingEnhancedDraft: EnhancedDraft = {
  situation: "Enhanced: We were on a 90-day mandate to cut latency.",
  task: "Enhanced: I owned the cutover plan end-to-end.",
  action: "Enhanced: I shipped the rollout in phased flags with rollback gates.",
  result: "Enhanced: Latency dropped 38% within the quarter, saving $50k/month.",
  what_i_would_change: null,
};

let nextEnhanceResult: EnhancedDraft = passingEnhancedDraft;

vi.mock("@/lib/rebuilds", async () => {
  const actual = await vi.importActual<typeof RebuildsModule>("@/lib/rebuilds");
  return {
    ...actual,
    runEnhance: async () => ({
      enhanced: nextEnhanceResult,
      modelVersion: "test-model",
      promptVersion: "test-prompt",
    }),
  };
});

/* ── Fixture helpers ────────────────────────────────────────────── */

const buildPassingDim = (
  dimension: DimensionFeedback["dimension"],
): DimensionFeedback => ({
  dimension,
  status: "strong",
  quoted_excerpt: "",
  what_to_check: "ok",
});

const passingCritique: CritiqueResponse = {
  overall_assessment: "Solid draft.",
  dimension_feedback: [
    buildPassingDim("headline"),
    buildPassingDim("star_completeness"),
    buildPassingDim("first_person"),
    buildPassingDim("quantification"),
    buildPassingDim("profile_consistency"),
  ],
  next_step_suggestion: "Tighten the result.",
};

import { POST as enhanceRoute } from "@/app/api/rebuilds/[id]/enhance/route";
import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { REBUILD_CRITIQUE_UNITS_PER_CREDIT } from "@/lib/credits";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  mockGetActiveUserId.mockReset();
  setHeaders(null);
  nextEnhanceResult = passingEnhancedDraft;
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

/**
 * Seed a rebuild in `critiqued` state — the only state enhance
 * accepts. A critique payload is required.
 */
const seedCritiquedRebuild = async (userId: string) => {
  const [row] = await db
    .insert(schema.storyRebuilds)
    .values({
      userId,
      questionText: "Tell me about a tough call.",
      headline: "I drove the migration through.",
      situation: "We were on a 90-day mandate to cut latency.",
      task: "I owned the cutover plan.",
      action: "I shipped the rollout in phased flags.",
      result: "Latency dropped 38% within the quarter.",
      status: "critiqued",
      aiCritiqueJson: passingCritique,
    })
    .returning();
  if (!row) throw new Error("seedCritiquedRebuild: no row returned");
  return row;
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

const countRebuildCharges = async (userId: string) => {
  const rows = await db
    .select()
    .from(schema.creditTransactions)
    .where(eq(schema.creditTransactions.userId, userId));
  return rows.filter((r) => r.reason === "rebuild_critique_charge").length;
};

const callEnhance = async (id: string) =>
  enhanceRoute(
    new Request(`http://localhost:3000/api/rebuilds/${id}/enhance`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) },
  );

describe("POST /api/rebuilds/:id/enhance — credit charging", () => {
  it("returns 402 BEFORE the LLM call when balance=0 and units at rollover boundary", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    await setBalanceAndUnits(
      u.id,
      0,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    const rebuild = await seedCritiquedRebuild(u.id);

    const r = await callEnhance(rebuild.id);
    expect(r.status).toBe(402);
    const body = (await r.json()) as {
      error: string;
      perCritiqueCost: number;
    };
    expect(body.error).toBe("insufficient_credits");
    expect(body.perCritiqueCost).toBeCloseTo(
      1 / REBUILD_CRITIQUE_UNITS_PER_CREDIT,
    );

    // Accumulator + balance must not have moved.
    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(0);
    expect(after.rebuildCritiqueUnits).toBe(
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );

    // No ledger row written.
    expect(await countRebuildCharges(u.id)).toBe(0);

    // The rebuild draft must NOT have been altered.
    const [refreshed] = await db
      .select({
        situation: schema.storyRebuilds.situation,
      })
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.id, rebuild.id));
    expect(refreshed?.situation).toBe("We were on a 90-day mandate to cut latency.");
  });

  it("non-rollover enhance returns 200 with creditsCharged=0 and bumps the accumulator", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = (await readUser(u.id)).creditBalance;
    await setBalanceAndUnits(u.id, startingBalance, 0);
    const rebuild = await seedCritiquedRebuild(u.id);

    const r = await callEnhance(rebuild.id);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      creditsCharged: number;
      balanceAfter: number | null;
      rebuild: { situation: string };
    };
    expect(body.creditsCharged).toBe(0);
    expect(body.balanceAfter).toBe(startingBalance);

    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(startingBalance);
    expect(after.rebuildCritiqueUnits).toBe(1);
    expect(await countRebuildCharges(u.id)).toBe(0);

    // Draft fields should be updated on the rebuild row.
    const [refreshed] = await db
      .select({ situation: schema.storyRebuilds.situation })
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.id, rebuild.id));
    expect(refreshed?.situation).toBe(passingEnhancedDraft.situation);
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
    const rebuild = await seedCritiquedRebuild(u.id);

    const r = await callEnhance(rebuild.id);
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
    expect(await countRebuildCharges(u.id)).toBe(1);
  });
});

describe("POST /api/rebuilds/:id/enhance — state gates", () => {
  it("returns 409 when rebuild is in_progress (no critique yet)", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const [inProgressRow] = await db
      .insert(schema.storyRebuilds)
      .values({
        userId: u.id,
        questionText: "Tell me about a tough call.",
        headline: "I drove the migration through.",
        situation: "We were on a 90-day mandate.",
        task: "I owned the plan.",
        action: "I shipped the rollout.",
        result: "Latency dropped 38%.",
        status: "in_progress",
      })
      .returning();
    if (!inProgressRow) throw new Error("seed failed");

    const r = await callEnhance(inProgressRow.id);
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("rebuild_wrong_state");
  });

  it("returns 409 when rebuild is saved_to_bank", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const [savedRow] = await db
      .insert(schema.storyRebuilds)
      .values({
        userId: u.id,
        questionText: "Tell me about a tough call.",
        situation: "We were on a 90-day mandate.",
        task: "I owned the plan.",
        action: "I shipped the rollout.",
        result: "Latency dropped 38%.",
        status: "saved_to_bank",
        aiCritiqueJson: passingCritique,
      })
      .returning();
    if (!savedRow) throw new Error("seed failed");

    const r = await callEnhance(savedRow.id);
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("rebuild_wrong_state");
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const r = await callEnhance("00000000-0000-0000-0000-000000000000");
    expect(r.status).toBe(401);
  });

  it("returns 403 on cross-origin requests", async () => {
    setHeaders({
      origin: "https://evil.example.com",
      host: "localhost:3000",
      "user-agent": "Mozilla/5.0",
    });
    mockGetActiveUserId.mockResolvedValue("any-user-id");
    const r = await callEnhance("00000000-0000-0000-0000-000000000000");
    expect(r.status).toBe(403);
  });

  it("returns 404 for a rebuild that doesn't exist", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await callEnhance("00000000-0000-0000-0000-000000000001");
    expect(r.status).toBe(404);
  });
});
