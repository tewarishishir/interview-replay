/**
 * Integration tests for `GET /api/profile`, `PATCH /api/profile`,
 * and `PATCH /api/profile/exclude`.
 *
 * The route handlers are imported and called directly with stub
 * Requests. `next/headers`, `getActiveUserId`, and the rate
 * limiter are mocked at module boundaries so each test can
 * express auth state in one line. The Drizzle layer hits the real
 * local Postgres so persistence assertions are end-to-end.
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

// Bypass real the rate limiter so we don't depend on env in tests.
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
  return {
    ...actual,
    profileWriteLimiter: () => open(),
    resumeParseLimiter: () => open(),
    resumeParsePollLimiter: () => open(),
  };
});

import { GET, PATCH } from "@/app/api/profile/route";
import { PATCH as PATCH_EXCLUDE } from "@/app/api/profile/exclude/route";
import { createCredentialsUser } from "@/lib/auth/users";
import { db, schema } from "@/lib/db";

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

describe("GET /api/profile", () => {
  it("returns 401 when not signed in", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the empty-defaults DTO for a brand-new user", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.yearsOfExperience).toBeNull();
    expect(body.profile.companies).toEqual([]);
    expect(body.profile.excludeResume).toBe(false);
    expect(body.profile.limits).toBeTruthy();
  });

  it("returns the persisted row on subsequent reads", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        yearsOfExperience: 7,
        currentRole: "Senior Engineer",
      }),
    );
    const res = await GET();
    const body = await res.json();
    expect(body.profile.yearsOfExperience).toBe(7);
    expect(body.profile.currentRole).toBe("Senior Engineer");
    expect(body.profile.resumeUpdatedAt).not.toBeNull();
  });
});

describe("PATCH /api/profile — auth + same-origin", () => {
  it("returns 401 when not signed in", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", { currentRole: "x" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 on a foreign Origin", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    setHeaders({
      origin: "https://evil.example.com",
      "user-agent": "vitest",
    });
    const res = await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        currentRole: "x",
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/profile — validation", () => {
  it("rejects an empty body (must include at least one field)", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {}),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("rejects out-of-range yearsOfExperience", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        yearsOfExperience: 200,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects companies array beyond 20 entries", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const companies = Array.from({ length: 21 }, (_, i) => ({
      name: `Co${i}`,
      role: "Eng",
      time_period: "2024",
    }));
    const res = await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", { companies }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects careerNarrative beyond 500 words", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const longNarrative = Array.from({ length: 600 }, () => "word").join(" ");
    const res = await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        careerNarrative: longNarrative,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("accepts companies with name only (role + time_period are optional)", async () => {
    // The form drops a row when `name` is empty but happily
    // submits a row with `name='Stripe'` and blank role/period.
    // The schema must mirror that.
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        companies: [
          { name: "Stripe", role: "", time_period: "" },
          { name: "LLM provider", role: "Eng", time_period: "" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.companies).toHaveLength(2);
    expect(body.profile.companies[0]).toEqual({
      name: "Stripe",
      role: null,
      time_period: null,
    });
    expect(body.profile.companies[1]).toEqual({
      name: "LLM provider",
      role: "Eng",
      time_period: null,
    });
  });

  it("accepts education with degree-only or institution-only", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        education: [
          { degree: "B.S.", institution: "", year: null, field: null },
          { degree: "", institution: "MIT", year: 2017, field: null },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.education).toHaveLength(2);
    expect(body.profile.education[0].degree).toBe("B.S.");
    expect(body.profile.education[0].institution).toBeNull();
    expect(body.profile.education[1].degree).toBeNull();
    expect(body.profile.education[1].institution).toBe("MIT");
  });

  it("REJECTS education entries with neither degree nor institution", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        education: [
          { degree: "", institution: "", year: 2020, field: "CS" },
        ],
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/profile — happy path", () => {
  it("creates the row on first save and stamps resumeUpdatedAt", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        yearsOfExperience: 5,
        currentRole: "Senior Engineer",
        companies: [{ name: "Stripe", role: "SWE", time_period: "2020-2024" }],
        markResumeSaved: true,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.yearsOfExperience).toBe(5);
    expect(body.profile.companies).toHaveLength(1);
    expect(body.profile.resumeSavedAt).not.toBeNull();
    expect(body.profile.resumeUpdatedAt).not.toBeNull();
    expect(body.profile.targetUpdatedAt).toBeNull();

    const [row] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, user.id));
    expect(row?.userId).toBe(user.id);
  });

  it("partial PATCH leaves untouched fields alone", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        yearsOfExperience: 5,
        currentRole: "Senior Engineer",
      }),
    );
    await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        careerNarrative: "I am a senior backend engineer.",
      }),
    );
    const res = await GET();
    const body = await res.json();
    expect(body.profile.yearsOfExperience).toBe(5);
    expect(body.profile.currentRole).toBe("Senior Engineer");
    expect(body.profile.careerNarrative).toBe(
      "I am a senior backend engineer.",
    );
    expect(body.profile.targetUpdatedAt).not.toBeNull();
  });

  it("clears a field when null is sent", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        currentRole: "Senior Engineer",
      }),
    );
    await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        currentRole: null,
      }),
    );
    const res = await GET();
    const body = await res.json();
    expect(body.profile.currentRole).toBeNull();
  });

  it("scopes writes to the authenticated user (multi-user isolation)", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");

    mockGetActiveUserId.mockResolvedValue(alice.id);
    await PATCH(
      jsonRequest("http://localhost/api/profile", "PATCH", {
        currentRole: "Alice's role",
      }),
    );

    mockGetActiveUserId.mockResolvedValue(bob.id);
    const res = await GET();
    const body = await res.json();
    expect(body.profile.currentRole).toBeNull();
  });
});

describe("PATCH /api/profile/exclude", () => {
  it("toggles excludeResume on a brand-new user (creates the row)", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await PATCH_EXCLUDE(
      jsonRequest("http://localhost/api/profile/exclude", "PATCH", {
        field: "resume",
        excluded: true,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.excludeResume).toBe(true);
    expect(body.profile.excludeProjects).toBe(false);
  });

  it("rejects an unknown field", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await PATCH_EXCLUDE(
      jsonRequest("http://localhost/api/profile/exclude", "PATCH", {
        field: "nope",
        excluded: true,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("persists across reads", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    await PATCH_EXCLUDE(
      jsonRequest("http://localhost/api/profile/exclude", "PATCH", {
        field: "stories",
        excluded: true,
      }),
    );
    const res = await GET();
    const body = await res.json();
    expect(body.profile.excludeStories).toBe(true);
  });
});
