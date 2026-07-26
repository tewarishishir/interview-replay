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

import { POST as storyEnhanceRoute } from "@/app/api/stories/enhance/route";
import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import {
  STORY_CRITIQUE_AUDIT_EVENT_TYPE,
  STORY_CRITIQUE_DAILY_CAP,
  STORY_ENHANCE_AUDIT_EVENT_TYPE,
} from "@/lib/stories";

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

const seedAuditRows = async (
  userId: string,
  count: number,
  eventType: string,
) => {
  for (let i = 0; i < count; i++) {
    await db.insert(schema.auditLog).values({
      userId,
      eventType,
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
    await seedAuditRows(u.id, STORY_CRITIQUE_DAILY_CAP - 1, STORY_CRITIQUE_AUDIT_EVENT_TYPE);

    const r = await callRoute();
    expect(r.status).toBe(200);
  });
});

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
    };

    expect(typeof body.enhanced.situation).toBe("string");
    expect(typeof body.enhanced.task).toBe("string");
    expect(typeof body.enhanced.action).toBe("string");
    expect(typeof body.enhanced.result).toBe("string");
    expect(body.enhanced.situation).toBe(ENHANCED_DRAFT.situation);
    expect(body.enhanced.task).toBe(ENHANCED_DRAFT.task);
    expect(body.enhanced.action).toBe(ENHANCED_DRAFT.action);
    expect(body.enhanced.result).toBe(ENHANCED_DRAFT.result);
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
