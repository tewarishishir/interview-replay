/**
 * Integration tests for the POST `/api/sessions` route handler.
 *
 * We invoke the exported `POST` function directly with a stub
 * `Request`, mocking `auth()` and `next/headers` so the test is
 * pure-Node (no Playwright, no dev server). The Drizzle layer hits
 * the real local Postgres because that's the bit we actually want to
 * verify — the schema validation, the audit log row, and the 201
 * shape are only meaningful end-to-end.
 *
 * If the route handler is refactored, the failure mode here is
 * specific: the `vi.mock` calls below will surface a clear "unable
 * to import …" error rather than the test silently bypassing the
 * route.
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

/**
 * Headers stub. The route reads:
 *   - `origin` for the same-origin guard (we set localhost so it
 *     passes the dev escape-hatch),
 *   - `x-forwarded-for` for rate-limit + audit IP attribution,
 *   - `user-agent` for the audit row.
 *
 * Each test can override the next read via `setHeaders({...})`; the
 * default below is the "happy" set of headers for a logged-in
 * candidate hitting the form on localhost.
 */
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

/**
 * The route reads identity through `getActiveUserId`, which itself
 * combines `auth()` + a DB revocation check. We mock at THAT
 * boundary so each test can express "active user X", "no user",
 * or "user is soft-deleted" in one line, without having to wire a
 * fake JWT or stub the DB lookup. The dedicated coverage of
 * `getActiveUserId`'s revocation logic lives in
 * `tests/auth/session.test.ts`.
 */
const mockGetActiveUserId = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getActiveUserId: () => mockGetActiveUserId(),
}));

import { POST } from "@/app/api/sessions/route";
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

const jsonRequest = (body: unknown): Request =>
  new Request("http://localhost/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const VALID_BODY = {
  companyName: "Stripe",
  roleTitle: "Senior Backend Engineer",
  level: "senior",
  roundType: "system_design",
  scheduledAt: null,
  consentAffirmed: true,
};

describe("POST /api/sessions — auth gate", () => {
  it("returns 401 when no session is present", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await POST(jsonRequest(VALID_BODY));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");

    // No row was written.
    const rows = await db.select().from(schema.interviewSessions);
    expect(rows).toHaveLength(0);
  });

  it("returns 401 when the user has been soft-deleted (revocation)", async () => {
    // `getActiveUserId` returns null both for "no JWT" and "JWT
    // valid but user.deleted_at IS NOT NULL". The route MUST treat
    // both the same way — the existing layout-level revocation
    // check doesn't fire on API requests.
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await POST(jsonRequest(VALID_BODY));
    expect(res.status).toBe(401);

    const rows = await db.select().from(schema.interviewSessions);
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/sessions — same-origin guard", () => {
  it("returns 403 when the request has no Origin or Referer", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    setHeaders({
      "x-forwarded-for": "203.0.113.42",
      "user-agent": "vitest",
    });

    const res = await POST(jsonRequest(VALID_BODY));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("forbidden");

    const rows = await db.select().from(schema.interviewSessions);
    expect(rows).toHaveLength(0);
  });

  it("returns 403 when the Origin is a foreign domain", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    setHeaders({
      origin: "https://evil.example.com",
      "x-forwarded-for": "203.0.113.42",
      "user-agent": "vitest",
    });

    const res = await POST(jsonRequest(VALID_BODY));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/sessions — validation", () => {
  it("returns 400 with field errors when consentAffirmed is missing", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const { consentAffirmed: _drop, ...rest } = VALID_BODY;
    void _drop;
    const res = await POST(jsonRequest(rest));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    expect(body.fieldErrors).toHaveProperty("consentAffirmed");

    // No DB write.
    const rows = await db.select().from(schema.interviewSessions);
    expect(rows).toHaveLength(0);
  });

  it("returns 400 when consentAffirmed is false (the headline rule)", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await POST(jsonRequest({ ...VALID_BODY, consentAffirmed: false }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");

    const rows = await db.select().from(schema.interviewSessions);
    expect(rows).toHaveLength(0);
  });

  it('returns 400 when consentAffirmed is the string "true" (no coercion)', async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await POST(
      jsonRequest({ ...VALID_BODY, consentAffirmed: "true" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 with bad_json on a malformed body", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const req = new Request("http://localhost/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_json");
  });

  it("strips NUL bytes and bidi overrides from companyName / roleTitle", async () => {
    // A NUL byte in a Postgres `text` column would 5xx at insert
    // time. The schema's pre-insert sanitizer must strip it (and
    // related control / bidi-override characters) so the row lands
    // cleanly with just the visible text.
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await POST(
      jsonRequest({
        ...VALID_BODY,
        companyName: "Stripe\u0000Inc",
        roleTitle: "\u202ESenior\u202C Engineer",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session.companyName).toBe("StripeInc");
    expect(body.session.roleTitle).toBe("Senior Engineer");
  });
});

describe("POST /api/sessions — happy path", () => {
  it("returns 201 with the created session and writes a session.created audit row", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await POST(jsonRequest(VALID_BODY));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.session).toMatchObject({
      companyName: "Stripe",
      roleTitle: "Senior Backend Engineer",
      level: "senior",
      roundType: "system_design",
      state: "created",
    });
    expect(body.session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.session.consentAffirmedAt).toBe("string");

    // DB confirms ownership and state.
    const [row] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, body.session.id));
    expect(row?.userId).toBe(user.id);
    expect(row?.state).toBe("created");

    // Audit log captured the right event + IP.
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventType).toBe("session.created");
    expect(audits[0]?.ipAddress).toBe("203.0.113.42");
    expect(audits[0]?.userAgent).toBe("Mozilla/5.0 (vitest)");
  });

  it("ignores any userId in the body — uses the authenticated user only", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    mockGetActiveUserId.mockResolvedValue(alice.id);

    // Attacker tries to forge ownership by sending Bob's id.
    const res = await POST(
      jsonRequest({ ...VALID_BODY, userId: bob.id }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    const [row] = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, body.session.id));
    // Despite the body, the row is owned by the authenticated user.
    expect(row?.userId).toBe(alice.id);
  });
});
