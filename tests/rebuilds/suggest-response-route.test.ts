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

const callSuggest = async (id: string) =>
  suggestRoute(
    new Request(`http://localhost:3000/api/rebuilds/${id}/suggest-response`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) },
  );

describe("POST /api/rebuilds/:id/suggest-response", () => {
  it("returns 200 with suggestion on a passing generation", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const rebuild = await seedRebuild(u.id);

    const r = await callSuggest(rebuild.id);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      passedGuardrails: boolean;
    };
    expect(body.passedGuardrails).toBe(true);
  });

  it("synthetic fallback (passedGuardrails=false) preserves cached suggestion", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
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
      passedGuardrails: boolean;
      syntheticSuggestion: typeof passingSuggestion | null;
      rebuild: { aiSuggestedResponse: typeof cachedSuggestion | null };
    };
    expect(body.passedGuardrails).toBe(false);
    expect(body.syntheticSuggestion).not.toBeNull();
    expect(body.syntheticSuggestion?.headline).toBe(passingSuggestion.headline);
    expect(body.rebuild.aiSuggestedResponse?.headline).toBe(
      "Cached good draft",
    );

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
    const rebuild = await seedRebuild(u.id, { status: "saved_to_bank" });

    const r = await callSuggest(rebuild.id);
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("rebuild_wrong_state");
  });
});
