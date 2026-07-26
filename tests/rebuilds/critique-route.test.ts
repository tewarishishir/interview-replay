import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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

const callCritique = async (id: string) =>
  critiqueRoute(
    new Request(`http://localhost:3000/api/rebuilds/${id}/critique`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) },
  );

describe("POST /api/rebuilds/:id/critique — happy path", () => {
  it("returns 200 with the critique on success", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const rebuild = await seedRebuild(u.id);

    const r = await callCritique(rebuild.id);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { passedGuardrails: boolean };
    expect(body.passedGuardrails).toBe(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const r = await callCritique("00000000-0000-0000-0000-000000000000");
    expect(r.status).toBe(401);
  });

  it("returns 404 for a rebuild that doesn't exist", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const r = await callCritique("00000000-0000-0000-0000-000000000001");
    expect(r.status).toBe(404);
  });
});
