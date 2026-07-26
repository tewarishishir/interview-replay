/**
 * Integration tests for `/api/projects` (list, create, patch,
 * delete) and `/api/projects/reorder`.
 *
 * Mocks `next/headers`, `getActiveUserId`, and the rate limiter
 * boundary; hits the real Postgres for persistence assertions
 * (display order arithmetic and the "exactly your owned set"
 * reorder guard are only meaningful end-to-end).
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
  };
});

import { GET as LIST_PROJECTS, POST as CREATE_PROJECT } from "@/app/api/projects/route";
import {
  DELETE as DELETE_PROJECT,
  PATCH as PATCH_PROJECT,
} from "@/app/api/projects/[id]/route";
import { PATCH as REORDER_PROJECTS } from "@/app/api/projects/reorder/route";
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

const VALID_PROJECT = {
  name: "Multi-region payments migration",
  companyContext: "Stripe — Payments platform",
  timePeriod: "Q3 2023 — Q1 2024",
  scaleDescription: "500k transactions/day, $1B annualized volume.",
  teamSize: "6 engineers + 1 PM",
  myRole: "Tech lead",
  keyDecisions: "Picked dual-write over CDC.",
  outcomesWithMetrics: "P99 dropped 380ms → 110ms.",
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/projects", () => {
  it("returns 401 when not signed in", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await LIST_PROJECTS();
    expect(res.status).toBe(401);
  });

  it("returns an empty array for a brand-new user", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await LIST_PROJECTS();
    const body = await res.json();
    expect(body.projects).toEqual([]);
    expect(body.limits.max).toBe(5);
    expect(body.limits.recommendedMin).toBe(3);
  });
});

describe("POST /api/projects", () => {
  it("returns 401 when not signed in", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await CREATE_PROJECT(
      jsonRequest("http://localhost/api/projects", "POST", VALID_PROJECT),
    );
    expect(res.status).toBe(401);
  });

  it("creates a project at displayOrder 0 on first save", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await CREATE_PROJECT(
      jsonRequest("http://localhost/api/projects", "POST", VALID_PROJECT),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project.name).toBe(VALID_PROJECT.name);
    expect(body.project.displayOrder).toBe(0);
  });

  it("appends new projects after existing ones", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    for (let i = 0; i < 3; i++) {
      await CREATE_PROJECT(
        jsonRequest("http://localhost/api/projects", "POST", {
          ...VALID_PROJECT,
          name: `Project ${i}`,
        }),
      );
    }
    const res = await LIST_PROJECTS();
    const body = await res.json();
    expect(body.projects).toHaveLength(3);
    expect(body.projects.map((p: { displayOrder: number }) => p.displayOrder)).toEqual([0, 1, 2]);
  });

  it("returns 409 when the per-user cap (5) is reached", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    for (let i = 0; i < 5; i++) {
      await CREATE_PROJECT(
        jsonRequest("http://localhost/api/projects", "POST", {
          ...VALID_PROJECT,
          name: `Project ${i}`,
        }),
      );
    }
    const res = await CREATE_PROJECT(
      jsonRequest("http://localhost/api/projects", "POST", {
        ...VALID_PROJECT,
        name: "Project 6",
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("projects_limit_exceeded");
  });

  it("rejects empty name", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const res = await CREATE_PROJECT(
      jsonRequest("http://localhost/api/projects", "POST", {
        ...VALID_PROJECT,
        name: "",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/projects/:id", () => {
  it("updates a project owned by the user", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const create = await CREATE_PROJECT(
      jsonRequest("http://localhost/api/projects", "POST", VALID_PROJECT),
    );
    const { project } = await create.json();

    const res = await PATCH_PROJECT(
      jsonRequest(
        `http://localhost/api/projects/${project.id}`,
        "PATCH",
        { name: "Updated name" },
      ),
      ctx(project.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.name).toBe("Updated name");
  });

  it("returns 404 when patching another user's project", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");

    mockGetActiveUserId.mockResolvedValue(alice.id);
    const create = await CREATE_PROJECT(
      jsonRequest("http://localhost/api/projects", "POST", VALID_PROJECT),
    );
    const { project } = await create.json();

    mockGetActiveUserId.mockResolvedValue(bob.id);
    const res = await PATCH_PROJECT(
      jsonRequest(
        `http://localhost/api/projects/${project.id}`,
        "PATCH",
        { name: "Hijacked" },
      ),
      ctx(project.id),
    );
    expect(res.status).toBe(404);

    // Confirm the row wasn't touched.
    const [row] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, project.id));
    expect(row?.name).toBe(VALID_PROJECT.name);
  });

  it("returns 400 for an empty PATCH body", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const create = await CREATE_PROJECT(
      jsonRequest("http://localhost/api/projects", "POST", VALID_PROJECT),
    );
    const { project } = await create.json();

    const res = await PATCH_PROJECT(
      jsonRequest(
        `http://localhost/api/projects/${project.id}`,
        "PATCH",
        {},
      ),
      ctx(project.id),
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/projects/:id", () => {
  it("deletes a project owned by the user", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const create = await CREATE_PROJECT(
      jsonRequest("http://localhost/api/projects", "POST", VALID_PROJECT),
    );
    const { project } = await create.json();

    const res = await DELETE_PROJECT(
      jsonRequest(
        `http://localhost/api/projects/${project.id}`,
        "DELETE",
      ),
      ctx(project.id),
    );
    expect(res.status).toBe(204);

    const rows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, project.id));
    expect(rows).toHaveLength(0);
  });

  it("returns 404 when deleting another user's project", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");

    mockGetActiveUserId.mockResolvedValue(alice.id);
    const create = await CREATE_PROJECT(
      jsonRequest("http://localhost/api/projects", "POST", VALID_PROJECT),
    );
    const { project } = await create.json();

    mockGetActiveUserId.mockResolvedValue(bob.id);
    const res = await DELETE_PROJECT(
      jsonRequest(
        `http://localhost/api/projects/${project.id}`,
        "DELETE",
      ),
      ctx(project.id),
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/projects/reorder", () => {
  it("reorders projects atomically", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await CREATE_PROJECT(
        jsonRequest("http://localhost/api/projects", "POST", {
          ...VALID_PROJECT,
          name: `Project ${i}`,
        }),
      );
      const { project } = await r.json();
      ids.push(project.id);
    }

    // Reverse the order.
    const reversed = [...ids].reverse();
    const res = await REORDER_PROJECTS(
      jsonRequest("http://localhost/api/projects/reorder", "PATCH", {
        project_ids_in_order: reversed,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(reversed);
    expect(body.projects.map((p: { displayOrder: number }) => p.displayOrder)).toEqual([0, 1, 2]);

    const list = await LIST_PROJECTS();
    const listBody = await list.json();
    expect(listBody.projects.map((p: { id: string }) => p.id)).toEqual(reversed);
  });

  it("returns 409 when the supplied list is missing projects", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await CREATE_PROJECT(
        jsonRequest("http://localhost/api/projects", "POST", {
          ...VALID_PROJECT,
          name: `Project ${i}`,
        }),
      );
      const { project } = await r.json();
      ids.push(project.id);
    }

    const res = await REORDER_PROJECTS(
      jsonRequest("http://localhost/api/projects/reorder", "PATCH", {
        project_ids_in_order: [ids[0]],
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("project_reorder_mismatch");
  });

  it("rejects duplicate ids in the reorder list", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const r = await CREATE_PROJECT(
      jsonRequest("http://localhost/api/projects", "POST", VALID_PROJECT),
    );
    const { project } = await r.json();

    const res = await REORDER_PROJECTS(
      jsonRequest("http://localhost/api/projects/reorder", "PATCH", {
        project_ids_in_order: [project.id, project.id],
      }),
    );
    expect(res.status).toBe(400);
  });
});
