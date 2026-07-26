/**
 * Integration tests for `POST /api/rebuilds/:id/critique` focused
 * on the credit-charging surface added after launch.
 *
 * What we cover:
 *   - 402 when the user is at the rollover boundary with zero
 *     balance — the LLM call is skipped (preflight short-circuit).
 *   - 200 + creditsCharged=0 on a non-rollover critique that
 *     bumps the accumulator without touching the balance.
 *   - 200 + creditsCharged=1 when the Nth critique rolls over,
 *     plus a `rebuild_critique_charge` ledger row.
 *   - Fallback critiques (guardrails tripped) DO charge — the
 *     route persists a structural fallback critique the user can
 *     act on, and we already paid LLM provider for the call. Pinned
 *     here so the "every click costs 0.20 credits" CTA copy
 *     stays truthful regardless of whether the model's output
 *     happened to trip a guardrail.
 *
 * The `runCritique` helper is stubbed so the tests don't need an
 * LLM provider API key. The credit/accumulator logic is the real
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
import type {
  CritiqueResponse,
  DimensionFeedback,
} from "@/lib/rebuilds/schemas";

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

// Stub the LLM round-trip. Tests configure the per-call return
// value via `setNextCritiqueResult`. The default is a passing
// real-critique result.
//
// The shape mirrors `critiqueResponseSchema` (5-7 dimensions). The
// route doesn't re-validate (the runner is responsible) but matching
// the schema keeps the fixture a sensible reference for future
// downstream consumers that DO validate.
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
];
const passingCritique: CritiqueResponse = {
  overall_assessment: "Solid draft.",
  dimension_feedback: passingDimensions,
  next_step_suggestion: "Tighten the result.",
};

let nextCritiqueResult: {
  critique: CritiqueResponse;
  passedGuardrails: boolean;
} = { critique: passingCritique, passedGuardrails: true };

const setNextCritiqueResult = (
  next: typeof nextCritiqueResult | null,
) => {
  if (next) nextCritiqueResult = next;
};

vi.mock("@/lib/rebuilds", async () => {
  const actual = await vi.importActual<typeof RebuildsModule>(
    "@/lib/rebuilds",
  );
  return {
    ...actual,
    runCritique: async () => ({
      critique: nextCritiqueResult.critique,
      passedGuardrails: nextCritiqueResult.passedGuardrails,
      guardrailFailures: nextCritiqueResult.passedGuardrails ? [] : [],
      modelVersion: "test-model",
      promptVersion: "test-prompt",
    }),
  };
});

import { POST as critiqueRoute } from "@/app/api/rebuilds/[id]/critique/route";
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
  // Default each test back to the passing-critique stub.
  nextCritiqueResult = { critique: passingCritique, passedGuardrails: true };
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

const seedRebuild = async (userId: string) => {
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
    })
    .returning();
  if (!row) throw new Error("seedRebuild: no row returned");
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

const callCritique = async (id: string) =>
  critiqueRoute(
    new Request(`http://localhost:3000/api/rebuilds/${id}/critique`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) },
  );

describe("POST /api/rebuilds/:id/critique — credit charging", () => {
  it("returns 402 BEFORE the LLM call when balance=0 and units at rollover boundary", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    await setBalanceAndUnits(
      u.id,
      0,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    const rebuild = await seedRebuild(u.id);

    // If the route hit the LLM stub, this would mutate the row;
    // instead we should see the row unchanged.
    const r = await callCritique(rebuild.id);
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

    // The rebuild row should NOT have been advanced to `critiqued`.
    const [refreshed] = await db
      .select({ status: schema.storyRebuilds.status })
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.id, rebuild.id));
    expect(refreshed?.status).toBe("in_progress");
  });

  it("non-rollover critique returns 200 with creditsCharged=0 and bumps the accumulator", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = (await readUser(u.id)).creditBalance;
    await setBalanceAndUnits(u.id, startingBalance, 0);
    const rebuild = await seedRebuild(u.id);

    const r = await callCritique(rebuild.id);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      creditsCharged: number;
      balanceAfter: number | null;
      passedGuardrails: boolean;
    };
    expect(body.creditsCharged).toBe(0);
    expect(body.balanceAfter).toBe(startingBalance);
    expect(body.passedGuardrails).toBe(true);

    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(startingBalance);
    expect(after.rebuildCritiqueUnits).toBe(1);
    expect(await countRebuildCharges(u.id)).toBe(0);
  });

  it("rollover critique returns 200 with creditsCharged=1 and writes a ledger row", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = 5;
    await setBalanceAndUnits(
      u.id,
      startingBalance,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    const rebuild = await seedRebuild(u.id);

    const r = await callCritique(rebuild.id);
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

  // Fallback critiques (guardrails tripped → stripped basic
  // critique, OR LLM-validation failed → synthetic structural
  // critique) STILL charge. The route persists the fallback via
  // `applyCritique` so the user sees a real critique view, and
  // we already paid LLM provider for the round-trip — skipping the
  // bill on this path would make the "0.20 credits per critique"
  // CTA copy look like a lie to the user.
  //
  // Two scenarios are pinned: a non-rollover fallback (counter
  // bumps but balance is untouched) and a rollover fallback (the
  // 5th call deducts a whole credit + writes a ledger row).
  it("fallback critique (guardrails tripped) charges on the non-rollover branch", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = (await readUser(u.id)).creditBalance;
    await setBalanceAndUnits(u.id, startingBalance, 0);
    const rebuild = await seedRebuild(u.id);

    setNextCritiqueResult({
      critique: passingCritique,
      passedGuardrails: false,
    });

    const r = await callCritique(rebuild.id);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      creditsCharged: number;
      balanceAfter: number | null;
      passedGuardrails: boolean;
    };
    expect(body.passedGuardrails).toBe(false);
    expect(body.creditsCharged).toBe(0);
    expect(body.balanceAfter).toBe(startingBalance);

    // Accumulator advanced by 1 unit (= 0.20 credits) even though
    // guardrails tripped. Balance untouched, no ledger row yet
    // (rollover happens on the 5th call).
    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(startingBalance);
    expect(after.rebuildCritiqueUnits).toBe(1);
    expect(await countRebuildCharges(u.id)).toBe(0);
  });

  it("fallback critique (guardrails tripped) charges on the rollover branch", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = 5;
    await setBalanceAndUnits(
      u.id,
      startingBalance,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    const rebuild = await seedRebuild(u.id);

    setNextCritiqueResult({
      critique: passingCritique,
      passedGuardrails: false,
    });

    const r = await callCritique(rebuild.id);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      creditsCharged: number;
      balanceAfter: number | null;
      passedGuardrails: boolean;
    };
    expect(body.passedGuardrails).toBe(false);
    expect(body.creditsCharged).toBe(1);
    expect(body.balanceAfter).toBe(startingBalance - 1);

    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(startingBalance - 1);
    expect(after.rebuildCritiqueUnits).toBe(0);
    expect(await countRebuildCharges(u.id)).toBe(1);
  });
});
