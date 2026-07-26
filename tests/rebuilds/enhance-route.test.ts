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

const callEnhance = async (id: string) =>
  enhanceRoute(
    new Request(`http://localhost:3000/api/rebuilds/${id}/enhance`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) },
  );

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

describe("POST /api/rebuilds/:id/enhance — happy path", () => {
  it("returns 200 and updates the draft fields on success", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);
    const rebuild = await seedCritiquedRebuild(u.id);

    const r = await callEnhance(rebuild.id);
    expect(r.status).toBe(200);

    const [refreshed] = await db
      .select({ situation: schema.storyRebuilds.situation })
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.id, rebuild.id));
    expect(refreshed?.situation).toBe(passingEnhancedDraft.situation);
  });
});
