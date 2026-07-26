/**
 * Integration tests for POST /api/users/me/theme — the endpoint
 * that persists the user's light/dark/system preference.
 *
 * Behaviors:
 *   - 403 on cross-origin requests (CSRF guard).
 *   - 401 for unauthenticated callers.
 *   - 400 on a non-JSON body or an invalid `theme` value.
 *   - 200 with the new theme + cookie set on success.
 *   - `users.theme_preference` is updated to match.
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

const DEFAULT_HEADERS = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "sec-fetch-site": "same-origin",
};
let headerOverride: Record<string, string> | null = null;
const setHeaders = (h: Record<string, string> | null) => {
  headerOverride = h;
};

// `cookies()` is mutated by the endpoint via `set()`; mock the store
// to record what was set and let the assertions verify the value.
const cookieStore = {
  set: vi.fn(),
};
const resetCookieMock = () => {
  cookieStore.set.mockReset();
};

vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerOverride ?? DEFAULT_HEADERS),
  cookies: async () => cookieStore,
}));

const mockGetActiveUserId = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getActiveUserId: () => mockGetActiveUserId(),
}));

import { POST } from "@/app/api/users/me/theme/route";
import { createCredentialsUser } from "@/lib/auth/users";
import { db, schema } from "@/lib/db";
import { THEME_COOKIE_NAME } from "@/lib/theme/types";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  mockGetActiveUserId.mockReset();
  resetCookieMock();
  setHeaders(null);
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

const seedUser = async (email: string) => {
  const r = await createCredentialsUser({
    email,
    password: "password123",
    name: email,
  });
  if (!r.ok) throw new Error(`seedUser: ${r.error}`);
  return r.user;
};

const buildRequest = (body: unknown): Request => {
  return new Request("http://localhost:3000/api/users/me/theme", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
};

describe("POST /api/users/me/theme", () => {
  it("rejects cross-origin requests with 403", async () => {
    setHeaders({
      origin: "http://evil.example.com",
      host: "localhost:3000",
      "sec-fetch-site": "cross-site",
    });
    const res = await POST(buildRequest({ theme: "light" }));
    expect(res.status).toBe(403);
    expect(mockGetActiveUserId).not.toHaveBeenCalled();
  });

  it("returns 401 when not signed in", async () => {
    mockGetActiveUserId.mockResolvedValueOnce(null);
    const res = await POST(buildRequest({ theme: "light" }));
    expect(res.status).toBe(401);
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body with 400", async () => {
    const user = await seedUser("user-bad-body@example.com");
    mockGetActiveUserId.mockResolvedValueOnce(user.id);
    const res = await POST(buildRequest("this is not json"));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid theme value with 400", async () => {
    const user = await seedUser("user-bad-theme@example.com");
    mockGetActiveUserId.mockResolvedValueOnce(user.id);
    const res = await POST(buildRequest({ theme: "neon" }));
    expect(res.status).toBe(400);

    // The DB row should still hold the default — no partial write.
    const [row] = await db
      .select({ theme: schema.users.themePreference })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .limit(1);
    expect(row?.theme).toBe("system");
  });

  it.each(["light", "dark", "system"] as const)(
    "persists '%s' to users.theme_preference and sets the cookie",
    async (theme) => {
      const user = await seedUser(`user-${theme}@example.com`);
      mockGetActiveUserId.mockResolvedValueOnce(user.id);

      const res = await POST(buildRequest({ theme }));
      expect(res.status).toBe(200);

      const payload = (await res.json()) as { theme: string };
      expect(payload.theme).toBe(theme);

      // Cookie was set with the right name + value.
      expect(cookieStore.set).toHaveBeenCalledTimes(1);
      const setCall = cookieStore.set.mock.calls[0]?.[0] as {
        name: string;
        value: string;
        sameSite: string;
        path: string;
      };
      expect(setCall.name).toBe(THEME_COOKIE_NAME);
      expect(setCall.value).toBe(theme);
      expect(setCall.sameSite).toBe("lax");
      expect(setCall.path).toBe("/");

      // DB reflects the change.
      const [row] = await db
        .select({ theme: schema.users.themePreference })
        .from(schema.users)
        .where(eq(schema.users.id, user.id))
        .limit(1);
      expect(row?.theme).toBe(theme);
    },
  );

  it("returns Cache-Control: no-store so proxies never cache a personalized response", async () => {
    const user = await seedUser("user-cache@example.com");
    mockGetActiveUserId.mockResolvedValueOnce(user.id);
    const res = await POST(buildRequest({ theme: "light" }));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
