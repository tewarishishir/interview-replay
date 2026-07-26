/**
 * Integration tests for `/api/stories` and `/api/stories/themes`.
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

import type * as RateLimitModule from "@/lib/rate-limit";

const DEFAULT_HEADERS = {
  origin: "http://localhost:3000",
  "user-agent": "vitest",
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
  const open = () => ({
    check: vi.fn(async () => ({
      success: true,
      limit: 999,
      remaining: 999,
      reset: Date.now() + 60_000,
    })),
  });
  return { ...actual, profileWriteLimiter: () => open() };
});

import { GET as LIST_STORIES, POST as CREATE_STORY } from "@/app/api/stories/route";
import {
  DELETE as DELETE_STORY,
  PATCH as PATCH_STORY,
} from "@/app/api/stories/[id]/route";
import { GET as LIST_THEMES } from "@/app/api/stories/themes/route";
import { createCredentialsUser } from "@/lib/auth/users";

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
  const result = await createCredentialsUser({
    email,
    password: "password123",
    name: "Alice",
  });
  if (!result.ok) throw new Error(`seedUser failed: ${result.error}`);
  return result.user;
};

const jsonRequest = (
  url: string,
  method: string,
  body?: unknown,
): Request =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const STORY_BODY = {
  theme: "leadership_conflict" as const,
  title: "Pushed back on a quarterly plan",
  situation: "We were a quarter into shipping...",
  task: "I was the staff engineer...",
  action: "I built a counter-proposal...",
  result: "We adopted my plan...",
  whatILearned: "Senior leaders need data, not just opinions.",
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/stories/themes", () => {
  it("returns 401 when not signed in", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await LIST_THEMES();
    expect(res.status).toBe(401);
  });

  it("returns the themes + word targets for a signed-in user", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await LIST_THEMES();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.themes).toBeInstanceOf(Array);
    expect(body.themes.length).toBeGreaterThan(5);
    expect(body.themes[0]).toHaveProperty("value");
    expect(body.themes[0]).toHaveProperty("label");
    expect(body.fieldWordTargets.situation).toEqual({ min: 50, max: 200 });
  });
});

describe("POST /api/stories", () => {
  it("returns 401 when not signed in", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await CREATE_STORY(
      jsonRequest("http://localhost/api/stories", "POST", STORY_BODY),
    );
    expect(res.status).toBe(401);
  });

  it("creates a story for each of the predefined themes", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const themes = [
      "leadership_conflict",
      "biggest_failure",
      "technical_disagreement",
      "ambiguous_problem",
      "mentoring",
      "cross_team_collaboration",
      "deadline_pressure",
      "difficult_colleague",
      "outside_comfort_zone",
      "recovering_from_mistake",
      "other",
    ] as const;
    for (const t of themes) {
      const res = await CREATE_STORY(
        jsonRequest("http://localhost/api/stories", "POST", {
          ...STORY_BODY,
          theme: t,
          title: `Story for ${t}`,
        }),
      );
      expect(res.status).toBe(201);
    }
    const list = await LIST_STORIES();
    const body = await list.json();
    expect(body.stories).toHaveLength(themes.length);
  });

  it("rejects empty title", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await CREATE_STORY(
      jsonRequest("http://localhost/api/stories", "POST", {
        ...STORY_BODY,
        title: "",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown theme", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await CREATE_STORY(
      jsonRequest("http://localhost/api/stories", "POST", {
        ...STORY_BODY,
        theme: "nope",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH/DELETE /api/stories/:id", () => {
  it("updates a story owned by the user", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const create = await CREATE_STORY(
      jsonRequest("http://localhost/api/stories", "POST", STORY_BODY),
    );
    const { story } = await create.json();

    const res = await PATCH_STORY(
      jsonRequest(
        `http://localhost/api/stories/${story.id}`,
        "PATCH",
        { title: "Updated title" },
      ),
      ctx(story.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.story.title).toBe("Updated title");
  });

  it("returns 404 when patching another user's story", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");

    mockGetActiveUserId.mockResolvedValue(alice.id);
    const create = await CREATE_STORY(
      jsonRequest("http://localhost/api/stories", "POST", STORY_BODY),
    );
    const { story } = await create.json();

    mockGetActiveUserId.mockResolvedValue(bob.id);
    const res = await PATCH_STORY(
      jsonRequest(
        `http://localhost/api/stories/${story.id}`,
        "PATCH",
        { title: "Hijacked" },
      ),
      ctx(story.id),
    );
    expect(res.status).toBe(404);
  });

  it("deletes a story owned by the user", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const create = await CREATE_STORY(
      jsonRequest("http://localhost/api/stories", "POST", STORY_BODY),
    );
    const { story } = await create.json();

    const res = await DELETE_STORY(
      jsonRequest(`http://localhost/api/stories/${story.id}`, "DELETE"),
      ctx(story.id),
    );
    expect(res.status).toBe(204);

    const list = await LIST_STORIES();
    const body = await list.json();
    expect(body.stories).toHaveLength(0);
  });

  it("returns 404 when deleting another user's story", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");

    mockGetActiveUserId.mockResolvedValue(alice.id);
    const create = await CREATE_STORY(
      jsonRequest("http://localhost/api/stories", "POST", STORY_BODY),
    );
    const { story } = await create.json();

    mockGetActiveUserId.mockResolvedValue(bob.id);
    const res = await DELETE_STORY(
      jsonRequest(`http://localhost/api/stories/${story.id}`, "DELETE"),
      ctx(story.id),
    );
    expect(res.status).toBe(404);
  });
});
