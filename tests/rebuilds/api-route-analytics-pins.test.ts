/**
 * Integration tests for the new Practice Rebuild launch context
 * fields: `source_artifact_id` and `pre_selected_profile_item_id`.
 *
 * Headline contract under test:
 *   - Both fields are optional. Bodies that omit them still
 *     succeed (regression guard for the legacy launch paths).
 *   - `source_artifact_id` must point at an artifact on a session
 *     owned by the caller. Cross-tenant attempts → 404.
 *   - `pre_selected_profile_item_id` must be a project or story
 *     owned by the caller. Cross-tenant → 404.
 *   - When both are valid, the row stores them and the GET
 *     response surfaces them in the DTO.
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
    rebuildWriteLimiter: () => limiter,
    rebuildCritiqueLimiter: () => limiter,
  };
});

import { POST as createRoute } from "@/app/api/rebuilds/route";
import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";

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

async function seedCompleteSession(userId: string): Promise<string> {
  const created = await createSession({
    userId,
    companyName: "Acme",
    roleTitle: "Engineer",
    level: "senior",
    roundType: "behavioral",
    scheduledAt: null,
  });
  await db
    .update(schema.interviewSessions)
    .set({ state: "complete" })
    .where(eq(schema.interviewSessions.id, created.id));
  return created.id;
}

async function seedQuestionArtifact(sessionId: string): Promise<string> {
  const [row] = await db
    .insert(schema.artifacts)
    .values({
      sessionId,
      artifactType: "question",
      content: "Tell me about a tough decision you made.",
      displayOrder: 0,
      source: "user_added",
    })
    .returning({ id: schema.artifacts.id });
  return row!.id;
}

async function seedProject(userId: string): Promise<string> {
  const [row] = await db
    .insert(schema.projects)
    .values({ userId, name: "Stripe migration", displayOrder: 0 })
    .returning({ id: schema.projects.id });
  return row!.id;
}

async function seedStory(userId: string): Promise<string> {
  const [row] = await db
    .insert(schema.stories)
    .values({
      userId,
      theme: "leadership_conflict",
      title: "Convincing a skeptical staff engineer",
    })
    .returning({ id: schema.stories.id });
  return row!.id;
}

async function postCreate(body: Record<string, unknown>): Promise<Response> {
  return createRoute(
    new Request("http://localhost:3000/api/rebuilds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/rebuilds — source_artifact_id", () => {
  it("accepts a source_artifact_id that belongs to the caller", async () => {
    const u = await seedUser();
    const sessionId = await seedCompleteSession(u.id);
    const artifactId = await seedQuestionArtifact(sessionId);
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await postCreate({
      question_text: "Tell me about a tough call.",
      source_session_id: sessionId,
      source_artifact_id: artifactId,
    });
    expect(r.status).toBe(201);

    const [row] = await db
      .select()
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.userId, u.id));
    expect(row!.sourceArtifactId).toBe(artifactId);
  });

  it("rejects a source_artifact_id from another user's session", async () => {
    const owner = await seedUser("owner@example.com");
    const ownerSessionId = await seedCompleteSession(owner.id);
    const ownerArtifactId = await seedQuestionArtifact(ownerSessionId);

    const attacker = await seedUser("attacker@example.com");
    mockGetActiveUserId.mockResolvedValue(attacker.id);

    const r = await postCreate({
      question_text: "Tell me about a tough call.",
      source_artifact_id: ownerArtifactId,
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("source_artifact_not_found");
  });

  it("rejects an artifact id that doesn't exist", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await postCreate({
      question_text: "x",
      source_artifact_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.status).toBe(404);
  });

  it("rejects mismatched source_session_id and source_artifact_id", async () => {
    const u = await seedUser();
    const sessionA = await seedCompleteSession(u.id);
    const artifactA = await seedQuestionArtifact(sessionA);
    const sessionB = await seedCompleteSession(u.id);
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await postCreate({
      question_text: "x",
      source_session_id: sessionB,
      source_artifact_id: artifactA,
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("source_artifact_session_mismatch");
  });
});

describe("POST /api/rebuilds — pre_selected_profile_item_id", () => {
  it("accepts a project id owned by the caller", async () => {
    const u = await seedUser();
    const projectId = await seedProject(u.id);
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await postCreate({
      question_text: "Tell me about a tough call.",
      pre_selected_profile_item_id: projectId,
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      rebuild: { preSelectedProfileItemId: string | null };
    };
    expect(body.rebuild.preSelectedProfileItemId).toBe(projectId);
  });

  it("accepts a story id owned by the caller", async () => {
    const u = await seedUser();
    const storyId = await seedStory(u.id);
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await postCreate({
      question_text: "Tell me about a leadership conflict.",
      pre_selected_profile_item_id: storyId,
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      rebuild: { preSelectedProfileItemId: string | null };
    };
    expect(body.rebuild.preSelectedProfileItemId).toBe(storyId);
  });

  it("rejects a project id from another user", async () => {
    const owner = await seedUser("owner@example.com");
    const ownerProjectId = await seedProject(owner.id);
    const attacker = await seedUser("attacker@example.com");
    mockGetActiveUserId.mockResolvedValue(attacker.id);

    const r = await postCreate({
      question_text: "x",
      pre_selected_profile_item_id: ownerProjectId,
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("pre_selected_profile_item_not_found");
  });

  it("rejects a story id from another user", async () => {
    const owner = await seedUser("owner@example.com");
    const ownerStoryId = await seedStory(owner.id);
    const attacker = await seedUser("attacker@example.com");
    mockGetActiveUserId.mockResolvedValue(attacker.id);

    const r = await postCreate({
      question_text: "x",
      pre_selected_profile_item_id: ownerStoryId,
    });
    expect(r.status).toBe(404);
  });

  it("rejects a UUID that doesn't exist in either pool", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await postCreate({
      question_text: "x",
      pre_selected_profile_item_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.status).toBe(404);
  });
});

describe("POST /api/rebuilds — both new fields together", () => {
  it("stores both when both are valid", async () => {
    const u = await seedUser();
    const sessionId = await seedCompleteSession(u.id);
    const artifactId = await seedQuestionArtifact(sessionId);
    const projectId = await seedProject(u.id);
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await postCreate({
      question_text: "Tell me about a tough call.",
      source_session_id: sessionId,
      source_artifact_id: artifactId,
      pre_selected_profile_item_id: projectId,
    });
    expect(r.status).toBe(201);

    const [row] = await db
      .select()
      .from(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.userId, u.id));
    expect(row!.sourceArtifactId).toBe(artifactId);
    expect(row!.preSelectedProfileItemId).toBe(projectId);
  });

  it("DTO surfaces both fields", async () => {
    const u = await seedUser();
    const sessionId = await seedCompleteSession(u.id);
    const artifactId = await seedQuestionArtifact(sessionId);
    const storyId = await seedStory(u.id);
    mockGetActiveUserId.mockResolvedValue(u.id);

    const r = await postCreate({
      question_text: "Tell me about a leadership conflict.",
      source_session_id: sessionId,
      source_artifact_id: artifactId,
      pre_selected_profile_item_id: storyId,
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      rebuild: {
        sourceArtifactId: string | null;
        preSelectedProfileItemId: string | null;
      };
    };
    expect(body.rebuild.sourceArtifactId).toBe(artifactId);
    expect(body.rebuild.preSelectedProfileItemId).toBe(storyId);
  });
});
