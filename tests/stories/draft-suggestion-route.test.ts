/**
 * Integration tests for `POST /api/stories/draft-suggestion`.
 *
 * The form-time ephemeral endpoint — runs the same Haiku
 * pipeline as the saved-story / rebuild surfaces but does NOT
 * write anything to the database. Used by the Add-Story form to
 * prefill the STAR textareas.
 *
 * Cases exercised:
 *   - 200 + creditsCharged on a passing generation.
 *   - 200 + NO charge on synthetic fallback (passedGuardrails=false).
 *   - 400 on bad body (missing title / theme / wrong shape).
 *   - 401 when not signed in.
 *   - 402 when out of credits (preflight).
 *   - 403 on cross-origin.
 *   - 413 when the body is too large.
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
  "content-type": "application/json",
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
  headline: "I caught the staging deploy script before it touched prod.",
  situation: "We were 4 days into a release-week freeze.",
  task: "I owned the deploy automation as the on-call SRE.",
  action: "I read the script line-by-line and found the env mix-up.",
  result: "We avoided a full prod outage and shipped on schedule.",
  whatIWouldChange: null,
  sources: [],
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

import { POST as draftRoute } from "@/app/api/stories/draft-suggestion/route";
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

const callDraft = async (
  body: unknown,
  override?: Partial<RequestInit>,
): Promise<Response> => {
  const init: RequestInit = {
    method: "POST",
    body: JSON.stringify(body),
    ...override,
  };
  return draftRoute(
    new Request("http://localhost:3000/api/stories/draft-suggestion", init),
  );
};

describe("POST /api/stories/draft-suggestion", () => {
  it("returns 200 + suggestion on a passing generation, no DB writes", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = (await readUser(u.id)).creditBalance;
    await setBalanceAndUnits(u.id, startingBalance, 0);

    const r = await callDraft({
      title: "Pushed back on a hype-driven AI launch",
      theme: "leadership_conflict",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      suggestion: SuggestedResponse;
      passedGuardrails: boolean;
      creditsCharged: number;
      balanceAfter: number | null;
    };
    expect(body.passedGuardrails).toBe(true);
    expect(body.suggestion.headline).toBe(passingSuggestion.headline);
    expect(body.creditsCharged).toBe(0);
    expect(body.balanceAfter).toBe(startingBalance);

    // Accumulator advances even on a non-rollover charge.
    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(startingBalance);
    expect(after.rebuildCritiqueUnits).toBe(1);

    // No story rows were created — this endpoint is ephemeral.
    const stories = await db.select().from(schema.stories);
    expect(stories.length).toBe(0);
    // No rebuild rows either.
    const rebuilds = await db.select().from(schema.storyRebuilds);
    expect(rebuilds.length).toBe(0);
  });

  it("synthetic fallback: returns 200 with passedGuardrails=false and NO charge", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const startingBalance = (await readUser(u.id)).creditBalance;
    await setBalanceAndUnits(
      u.id,
      startingBalance,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );

    setNext({ suggestion: passingSuggestion, passedGuardrails: false });

    const r = await callDraft({
      title: "Some title",
      theme: "leadership_conflict",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      passedGuardrails: boolean;
      creditsCharged: number;
      balanceAfter: number | null;
    };
    expect(body.passedGuardrails).toBe(false);
    expect(body.creditsCharged).toBe(0);
    expect(body.balanceAfter).toBeNull();

    const after = await readUser(u.id);
    expect(after.creditBalance).toBe(startingBalance);
    // Accumulator unchanged — synthetic fallbacks don't bump it.
    expect(after.rebuildCritiqueUnits).toBe(
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
  });

  it("returns 400 on missing title", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const r = await callDraft({ theme: "leadership_conflict" });
    expect(r.status).toBe(400);
  });

  it("returns 400 on missing theme", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const r = await callDraft({ title: "Some title" });
    expect(r.status).toBe(400);
  });

  it("returns 400 on an invalid theme value", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const r = await callDraft({
      title: "Some title",
      theme: "not_a_theme",
    });
    expect(r.status).toBe(400);
  });

  it("returns 400 on a title that's only whitespace", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const r = await callDraft({
      title: "   ",
      theme: "leadership_conflict",
    });
    expect(r.status).toBe(400);
  });

  it("returns 402 BEFORE the LLM call when balance=0 and units at the rollover boundary", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    await setBalanceAndUnits(
      u.id,
      0,
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );
    const r = await callDraft({
      title: "Some title",
      theme: "leadership_conflict",
    });
    expect(r.status).toBe(402);
  });

  it("returns 401 when the caller is not signed in", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const r = await callDraft({
      title: "Some title",
      theme: "leadership_conflict",
    });
    expect(r.status).toBe(401);
  });

  it("returns 403 on cross-origin", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    setHeaders({ origin: "http://evil.example.com" });
    const r = await callDraft({
      title: "Some title",
      theme: "leadership_conflict",
    });
    expect(r.status).toBe(403);
  });

  it("returns 413 on a too-large body", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    // 4KB body cap; ship 8KB.
    const r = await callDraft(
      { title: "x".repeat(8 * 1024), theme: "leadership_conflict" },
      { headers: { "content-length": String(8 * 1024) } },
    );
    expect(r.status).toBe(413);
  });
});
