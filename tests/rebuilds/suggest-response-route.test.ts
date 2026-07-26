/**
 * Integration tests for `POST /api/rebuilds/:id/suggest-response`.
 *
 * Mirrors `tests/rebuilds/critique-route.test.ts` 1:1 — same auth
 * mocks, same rate-limit stub, same credit ledger setup. The
 * suggest-response route shares the credit accumulator with the
 * critique route in v1 (`rebuild_critique_units`), so the rollover
 * cases here exercise the same `chargeRebuildCritique` path
 * critiques do.
 *
 * Cases:
 *   - 402 when the user is at the rollover boundary with zero
 *     balance (preflight short-circuit).
 *   - 200 + creditsCharged=0 when guardrails pass but the
 *     accumulator just bumps without a rollover.
 *   - 200 + creditsCharged=1 when the rollover actually fires
 *     plus a `rebuild_critique_charge` ledger row.
 *   - 200 + creditsCharged=0 when the runner returned a synthetic
 *     fallback (passedGuardrails=false). NO persistence (the
 *     cached suggestion is preserved), no history append, no
 *     accumulator bump, no charge, no ledger row.
 *   - 429 when the per-rebuild 10/24h gate is full.
 *   - 409 when the rebuild is in `saved_to_bank` / `discarded`.
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
import type { SuggestedResponse } from "@/lib/rebuilds/schemas";

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

const passingSuggestion: SuggestedResponse = {
  headline: "I led a 3-engineer rewrite that cut p99 latency by 40%.",
  situation: "At Acme in 2023 we had a checkout API with a p99 of 2.4s.",
  task: "I owned the redesign as the new staff eng on the team.",
  action: "I split the path into a synchronous critical loop and async fan-out.",
  result: "p99 dropped to 1.4s in the first week and 800ms by EOQ.",
  whatIWouldChange: null,
  sources: [
    {
      field_path: "projects[id=p1].outcomes_with_metrics",
      field_value: "p99 cut from 2.4s to 800ms",
    },
  ],
  caveats: [],
};

let nextResult: {
  suggestion: SuggestedResponse;
  passedGuardrails: boolean;
} = { suggestion: passingSuggestion, passedGuardrails: true };

const setNext = (n: typeof nextResult) => {
  nextResult = n;
};

vi.mock("@/lib/rebuilds", async () => {
  const actual = await vi.importActual<typeof RebuildsModule>(
    "@/lib/rebuilds",
  );
  return {
    ...actual,
    runSuggestResponse: async () => ({
      suggestion: nextResult.suggestion,
      passedGuardrails: nextResult.passedGuardrails,
      modelVersion: "llm-small",
      promptVersion: "test-prompt",
      guardrailReason: nextResult.passedGuardrails ? undefined : "test fallback",
    }),
  };
});

import { POST as suggestRoute } from "@/app/api/rebuilds/[id]/suggest-response/route";
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
  nextResult = { suggestion: passingSuggestion, passedGuardrails: true };
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

const seedRebuild = async (
  userId: string,
  over: Partial<typeof schema.storyRebuilds.$inferInsert> = {},
) => {
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
      ...over,
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

const callSuggest = async (id: string) =>
  suggestRoute(
    new Request(`http://localhost:3000/api/rebuilds/${id}/suggest-response`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) },
  );

describe("POST /api/rebuilds/:id/suggest-response", () => {
  it("returns 402 BEFORE the LLM call when balance=0 and units at rollover boundary", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    await setBalanceAndUnits(
      u.id,
      0,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    const rebuild = await seedRebuild(u.id);

    const r = await callSuggest(rebuild.id);
    expect(r.status).toBe(402);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("insufficient_credits");

    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(0);
    expect(after.rebuildCritiqueUnits).toBe(
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );

    const [refreshed] = await db
      .select({ json: schema.storyRebuilds.aiSuggestedResponseJson })
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.id, rebuild.id));
    // Suggestion was never persisted because we 402'd preflight.
    expect(refreshed?.json).toBeNull();
  });

  it("non-rollover suggestion returns 200 with creditsCharged=0 and bumps the accumulator", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = (await readUser(u.id)).creditBalance;
    await setBalanceAndUnits(u.id, startingBalance, 0);
    const rebuild = await seedRebuild(u.id);

    const r = await callSuggest(rebuild.id);
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
    // Suggestions share the critique accumulator in v1.
    expect(after.rebuildCritiqueUnits).toBe(1);
    expect(await countRebuildCharges(u.id)).toBe(0);

    // Persistence sanity-check.
    const [refreshed] = await db
      .select({
        json: schema.storyRebuilds.aiSuggestedResponseJson,
        version: schema.storyRebuilds.aiSuggestedResponseModelVersion,
        at: schema.storyRebuilds.aiSuggestedResponseGeneratedAt,
      })
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.id, rebuild.id));
    expect(refreshed?.json).not.toBeNull();
    expect(refreshed?.version).toBe("llm-small");
    expect(refreshed?.at).not.toBeNull();
  });

  it("rollover suggestion returns 200 with creditsCharged=1 and writes a ledger row", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = 5;
    await setBalanceAndUnits(
      u.id,
      startingBalance,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    const rebuild = await seedRebuild(u.id);

    const r = await callSuggest(rebuild.id);
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

  it("synthetic fallback (passedGuardrails=false) does NOT charge, persist, or burn rate-gate slots", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = 5;
    await setBalanceAndUnits(
      u.id,
      startingBalance,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    // Pre-seed a previously-good cached suggestion. The fallback
    // path MUST NOT overwrite this — that would silently destroy
    // the user's prior draft on a regenerate.
    const cachedSuggestion = {
      headline: "Cached good draft",
      situation: "s",
      task: "t",
      action: "a",
      result: "r",
      whatIWouldChange: null,
      sources: [],
      caveats: [],
    };
    const cachedAt = new Date(Date.now() - 60 * 60 * 1000);
    const rebuild = await seedRebuild(u.id, {
      aiSuggestedResponseJson: cachedSuggestion,
      aiSuggestedResponseModelVersion: "llm-small",
      aiSuggestedResponseGeneratedAt: cachedAt,
    });

    setNext({ suggestion: passingSuggestion, passedGuardrails: false });

    const r = await callSuggest(rebuild.id);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      creditsCharged: number;
      balanceAfter: number | null;
      passedGuardrails: boolean;
      syntheticSuggestion: typeof passingSuggestion | null;
      rebuild: { aiSuggestedResponse: typeof cachedSuggestion | null };
    };
    expect(body.passedGuardrails).toBe(false);
    expect(body.creditsCharged).toBe(0);
    expect(body.balanceAfter).toBeNull();
    expect(body.syntheticSuggestion).not.toBeNull();
    expect(body.syntheticSuggestion?.headline).toBe(passingSuggestion.headline);
    // The echoed rebuild still carries the cached suggestion —
    // the server didn't overwrite it.
    expect(body.rebuild.aiSuggestedResponse?.headline).toBe(
      "Cached good draft",
    );

    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(startingBalance);
    expect(after.rebuildCritiqueUnits).toBe(
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    expect(await countRebuildCharges(u.id)).toBe(0);

    // Persistence sanity-check: the row's cached suggestion + the
    // history are unchanged.
    const [refreshed] = await db
      .select({
        json: schema.storyRebuilds.aiSuggestedResponseJson,
        at: schema.storyRebuilds.aiSuggestedResponseGeneratedAt,
        history: schema.storyRebuilds.suggestedResponseHistory,
      })
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.id, rebuild.id));
    expect(
      (refreshed?.json as { headline?: string } | null)?.headline,
    ).toBe("Cached good draft");
    expect(refreshed?.at?.toISOString()).toBe(cachedAt.toISOString());
    expect(refreshed?.history).toEqual([]);
  });

  it("returns 429 when the rebuild is at its 10/24h cap", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = 10;
    await setBalanceAndUnits(u.id, startingBalance, 0);

    // Pre-fill the suggested-response history with 10 in-window
    // entries so the gate trips on the very first call.
    const recentTimestamps = Array.from({ length: 10 }, (_, i) => ({
      at: new Date(Date.now() - (i + 1) * 60 * 60 * 1000).toISOString(),
      suggestion: { headline: `prior ${i}` },
    }));
    const rebuild = await seedRebuild(u.id, {
      suggestedResponseHistory: recentTimestamps,
    });

    const r = await callSuggest(rebuild.id);
    expect(r.status).toBe(429);
    const body = (await r.json()) as {
      error: string;
      retryAfter: number;
    };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it("returns 409 when the rebuild is already saved to bank", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    await setBalanceAndUnits(u.id, 10, 0);
    const rebuild = await seedRebuild(u.id, { status: "saved_to_bank" });

    const r = await callSuggest(rebuild.id);
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("rebuild_wrong_state");
  });
});
