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

    const r = await callDraft({
      title: "Pushed back on a hype-driven AI launch",
      theme: "leadership_conflict",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      suggestion: SuggestedResponse;
      passedGuardrails: boolean;
    };
    expect(body.passedGuardrails).toBe(true);
    expect(body.suggestion.headline).toBe(passingSuggestion.headline);

    const stories = await db.select().from(schema.stories);
    expect(stories.length).toBe(0);
    const rebuilds = await db.select().from(schema.storyRebuilds);
    expect(rebuilds.length).toBe(0);
  });

  it("synthetic fallback: returns 200 with passedGuardrails=false", async () => {
    const u = await seedUser();
    mockGetActiveUserId.mockResolvedValue(u.id);

    setNext({ suggestion: passingSuggestion, passedGuardrails: false });

    const r = await callDraft({
      title: "Some title",
      theme: "leadership_conflict",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      passedGuardrails: boolean;
    };
    expect(body.passedGuardrails).toBe(false);
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
    const r = await callDraft(
      { title: "x".repeat(8 * 1024), theme: "leadership_conflict" },
      { headers: { "content-length": String(8 * 1024) } },
    );
    expect(r.status).toBe(413);
  });
});
