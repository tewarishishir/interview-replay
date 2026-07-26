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

let nextCritiqueResult: {
  critique: CritiqueResponse;
  passedGuardrails: boolean;
} = { critique: passingCritique, passedGuardrails: true };

vi.mock("@/lib/stories", async () => {
  const actual = await vi.importActual<typeof StoriesModule>("@/lib/stories");
  return {
    ...actual,
    runStoryCritique: async () => ({
      critique: nextCritiqueResult.critique,
      passedGuardrails: nextCritiqueResult.passedGuardrails,
      guardrailFailures: [],
      modelVersion: "test-model",
      promptVersion: "test-prompt",
    }),
  };
});

import { POST as storyCritiqueRoute } from "@/app/api/stories/critique/route";
import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import {
  STORY_CRITIQUE_AUDIT_EVENT_TYPE,
  STORY_CRITIQUE_DAILY_CAP,
} from "@/lib/stories";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  mockGetActiveUserId.mockReset();
  setHeaders(null);
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

const seedPastCritiques = async (userId: string, count: number) => {
  for (let i = 0; i < count; i++) {
    await db.insert(schema.auditLog).values({
      userId,
      eventType: STORY_CRITIQUE_AUDIT_EVENT_TYPE,
      eventData: {},
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
};

const callRoute = (body: unknown = VALID_BODY) =>
  storyCritiqueRoute(
    new Request("http://localhost:3000/api/stories/critique", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("POST /api/stories/critique — auth", () => {
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

describe("POST /api/stories/critique — validation", () => {
  it("returns 400 on missing title", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const r = await callRoute({ ...VALID_BODY, title: "" });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_body");
  });

  it("returns 200 with all-empty STAR fields (stub returns passingCritique)", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const r = await callRoute({
      title: "Some story.",
      situation: "",
      task: "",
      action: "",
      result: "",
      whatILearned: "",
    });
    expect(r.status).toBe(200);
  });
});

describe("POST /api/stories/critique — rate limiting", () => {
  it("returns 429 when the per-user 10/24h cap is full", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    await seedPastCritiques(u.id, STORY_CRITIQUE_DAILY_CAP);

    const r = await callRoute();
    expect(r.status).toBe(429);
    const body = (await r.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfter).toBe("number");
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it("allows a critique when cap is not yet reached", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    await seedPastCritiques(u.id, STORY_CRITIQUE_DAILY_CAP - 1);

    const r = await callRoute();
    expect(r.status).toBe(200);
  });
});

describe("POST /api/stories/critique — success path", () => {
  it("returns critique + metadata with correct shape on a passing critique", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await callRoute();
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      critique: CritiqueResponse;
      passedGuardrails: boolean;
      guardrailTripCount: number;
    };
    expect(body.passedGuardrails).toBe(true);
    expect(body.guardrailTripCount).toBe(0);
    expect(Array.isArray(body.critique.dimension_feedback)).toBe(true);
    expect(typeof body.critique.overall_assessment).toBe("string");
    expect(typeof body.critique.next_step_suggestion).toBe("string");
  });

  it("writes a story_critique.unit_charged audit row on success", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const before = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, u.id),
          eq(schema.auditLog.eventType, STORY_CRITIQUE_AUDIT_EVENT_TYPE),
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
          eq(schema.auditLog.eventType, STORY_CRITIQUE_AUDIT_EVENT_TYPE),
        ),
      )
      .then(([r]) => r?.count ?? 0);

    expect(after).toBe(Number(before) + 1);
  });
});
