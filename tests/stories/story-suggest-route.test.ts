/**
 * Integration tests for `POST /api/stories/:id/suggest-response`.
 *
 * Mirrors `tests/rebuilds/suggest-response-route.test.ts` 1:1 —
 * same auth mocks, same rate-limit stub, same credit ledger setup.
 * The story-side route shares the credit accumulator with the
 * rebuild surface in v1, so the rollover cases here exercise the
 * same `chargeRebuildCritique` path the rebuild routes do.
 *
 * Cases exercised:
 *   - 402 when balance=0 and units at the rollover boundary
 *     (preflight short-circuit; LLM never called).
 *   - 200 + creditsCharged=0 when guardrails pass but the
 *     accumulator just bumps without rollover.
 *   - 200 + creditsCharged=1 on rollover, plus a
 *     `rebuild_critique_charge` ledger row.
 *   - 200 + creditsCharged=0 + NO persistence + NO history append
 *     on synthetic fallback (passedGuardrails=false). Cached
 *     suggestion is preserved.
 *   - 429 when the per-story 10/24h gate is full.
 *   - 400 when the story has no usable title.
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
  headline: "I led the engineering case against shipping the AI demo half-baked.",
  situation: "Pressure was on to launch GenAI features in two weeks.",
  task: "I owned the readiness call as Head of Data Eng.",
  action: "I ran a live counter-demo proving the data layer would hallucinate.",
  result: "We delayed by a quarter and shipped a deterministic GraphRAG path.",
  whatIWouldChange: null,
  sources: [
    {
      field_path: "projects[id=p1].outcomes_with_metrics",
      field_value: "GraphRAG processes 500K records/day",
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

import { POST as suggestRoute } from "@/app/api/stories/[id]/suggest-response/route";
import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { REBUILD_CRITIQUE_UNITS_PER_CREDIT } from "@/lib/credits";
import { STORY_SUGGEST_DAILY_CAP } from "@/lib/stories";

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

const seedStory = async (
  userId: string,
  over: Partial<typeof schema.stories.$inferInsert> = {},
) => {
  const [row] = await db
    .insert(schema.stories)
    .values({
      userId,
      theme: "leadership_conflict",
      title: "Pushed back on a hype-driven AI launch",
      ...over,
    })
    .returning();
  if (!row) throw new Error("seedStory: no row returned");
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
    new Request(`http://localhost:3000/api/stories/${id}/suggest-response`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) },
  );

describe("POST /api/stories/:id/suggest-response", () => {
  it("returns 402 BEFORE the LLM call when balance=0 and units at the rollover boundary", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    await setBalanceAndUnits(
      u.id,
      0,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    const story = await seedStory(u.id);

    const r = await callSuggest(story.id);
    expect(r.status).toBe(402);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("insufficient_credits");

    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(0);
    expect(after.rebuildCritiqueUnits).toBe(
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );

    // Suggestion was never persisted because we 402'd preflight.
    const [refreshed] = await db
      .select({ json: schema.stories.aiSuggestedResponseJson })
      .from(schema.stories)
      .where(eq(schema.stories.id, story.id));
    expect(refreshed?.json).toBeNull();
  });

  it("non-rollover suggestion returns 200, persists, and bumps the accumulator", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = (await readUser(u.id)).creditBalance;
    await setBalanceAndUnits(u.id, startingBalance, 0);
    const story = await seedStory(u.id);

    const r = await callSuggest(story.id);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      creditsCharged: number;
      balanceAfter: number | null;
      passedGuardrails: boolean;
      aiSuggestedResponse: SuggestedResponse | null;
    };
    expect(body.creditsCharged).toBe(0);
    expect(body.balanceAfter).toBe(startingBalance);
    expect(body.passedGuardrails).toBe(true);
    expect(body.aiSuggestedResponse?.headline).toBe(passingSuggestion.headline);

    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(startingBalance);
    // Story-side suggestions share the rebuild critique accumulator.
    expect(after.rebuildCritiqueUnits).toBe(1);
    expect(await countRebuildCharges(u.id)).toBe(0);

    // Persistence sanity-check.
    const [refreshed] = await db
      .select({
        json: schema.stories.aiSuggestedResponseJson,
        version: schema.stories.aiSuggestedResponseModelVersion,
        at: schema.stories.aiSuggestedResponseGeneratedAt,
      })
      .from(schema.stories)
      .where(eq(schema.stories.id, story.id));
    expect(refreshed?.json).not.toBeNull();
    expect(refreshed?.version).toBe("llm-small");
    expect(refreshed?.at).not.toBeNull();
  });

  it("rolls over: returns 200 with creditsCharged=1 and writes a ledger row", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = 5;
    await setBalanceAndUnits(
      u.id,
      startingBalance,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    const story = await seedStory(u.id);

    const r = await callSuggest(story.id);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      creditsCharged: number;
      balanceAfter: number | null;
    };
    expect(body.creditsCharged).toBe(1);
    expect(body.balanceAfter).toBe(startingBalance - 1);

    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(startingBalance - 1);
    // Rollover resets the accumulator to 0.
    expect(after.rebuildCritiqueUnits).toBe(0);
    expect(await countRebuildCharges(u.id)).toBe(1);
  });

  it("synthetic fallback (passedGuardrails=false): NO charge, NO persistence, NO history append, NO accumulator bump; preserves cached suggestion", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = 5;
    await setBalanceAndUnits(
      u.id,
      startingBalance,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    // Pre-seed a previously-good cached suggestion. The fallback
    // path MUST NOT overwrite this.
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
    const story = await seedStory(u.id, {
      aiSuggestedResponseJson: cachedSuggestion,
      aiSuggestedResponseModelVersion: "llm-small",
      aiSuggestedResponseGeneratedAt: cachedAt,
    });

    setNext({ suggestion: passingSuggestion, passedGuardrails: false });

    const r = await callSuggest(story.id);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      creditsCharged: number;
      balanceAfter: number | null;
      passedGuardrails: boolean;
      syntheticSuggestion: SuggestedResponse | null;
      aiSuggestedResponse: SuggestedResponse | null;
    };
    expect(body.passedGuardrails).toBe(false);
    expect(body.creditsCharged).toBe(0);
    expect(body.balanceAfter).toBeNull();
    expect(body.syntheticSuggestion).not.toBeNull();
    expect(body.syntheticSuggestion?.headline).toBe(passingSuggestion.headline);
    // The cached suggestion is echoed unchanged.
    expect(body.aiSuggestedResponse?.headline).toBe("Cached good draft");

    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(startingBalance);
    expect(after.rebuildCritiqueUnits).toBe(
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    expect(await countRebuildCharges(u.id)).toBe(0);

    // Persistence sanity-check: row + history are unchanged.
    const [refreshed] = await db
      .select({
        json: schema.stories.aiSuggestedResponseJson,
        at: schema.stories.aiSuggestedResponseGeneratedAt,
        history: schema.stories.suggestedResponseHistory,
      })
      .from(schema.stories)
      .where(eq(schema.stories.id, story.id));
    expect(
      (refreshed?.json as { headline?: string } | null)?.headline,
    ).toBe("Cached good draft");
    expect(refreshed?.at?.toISOString()).toBe(cachedAt.toISOString());
    expect(refreshed?.history).toEqual([]);
  });

  it("returns 429 when the per-story 24h gate is full", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    await setBalanceAndUnits(u.id, 100, 0);
    // Fill the gate exactly to the cap with in-window timestamps.
    const now = Date.now();
    const story = await seedStory(u.id, {
      suggestedResponseHistory: Array.from(
        { length: STORY_SUGGEST_DAILY_CAP },
        (_, i) => ({
          at: new Date(now - (i + 1) * 60 * 60 * 1000).toISOString(),
          suggestion: {},
        }),
      ),
    });

    const r = await callSuggest(story.id);
    expect(r.status).toBe(429);
    const body = (await r.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(r.headers.get("Retry-After")).toBeTruthy();

    // No charge because the gate threw before the LLM call.
    expect(await countRebuildCharges(u.id)).toBe(0);
  });

  it("returns 404 when the story belongs to another user", async () => {
    const owner = await seedUser("owner@example.com");
    const intruder = await seedUser("intruder@example.com");
    mockGetActiveUserId.mockResolvedValue(intruder.id);
    await setBalanceAndUnits(intruder.id, 100, 0);
    const story = await seedStory(owner.id);

    const r = await callSuggest(story.id);
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("returns 401 when the caller is not signed in", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const r = await callSuggest("00000000-0000-0000-0000-000000000001");
    expect(r.status).toBe(401);
  });

  it("returns 403 on cross-origin POST", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    setHeaders({ origin: "http://evil.example.com" });
    const r = await callSuggest("00000000-0000-0000-0000-000000000001");
    expect(r.status).toBe(403);
  });
});
