/**
 * Unit tests for `resolveTheme` — the server-side helper that
 * decides which theme to stamp on `<html data-theme>` for the
 * first paint.
 *
 * Priority chain under test (in this order):
 *   1. The `ir-theme` cookie (if a valid value).
 *   2. `users.theme_preference` for the signed-in user.
 *   3. The fallback `'system'`.
 *
 * For `'system'`, the resolver consults the
 * `sec-ch-prefers-color-scheme` client hint header; missing the
 * hint falls back to `'dark'` (per spec — matches what the app
 * shipped with before theming).
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

let cookieValue: string | undefined;
let headerHint: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "ir-theme" && cookieValue !== undefined
        ? { value: cookieValue }
        : undefined,
  }),
  headers: async () => {
    const h = new Headers();
    if (headerHint !== undefined) {
      h.set("sec-ch-prefers-color-scheme", headerHint);
    }
    return h;
  },
}));

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

import { resolveTheme } from "@/lib/theme/resolve";
import { createCredentialsUser } from "@/lib/auth/users";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  cookieValue = undefined;
  headerHint = undefined;
  mockAuth.mockReset();
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

describe("resolveTheme", () => {
  it("returns 'system' / 'dark' when no cookie, no session, no client hint", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const result = await resolveTheme();
    expect(result).toEqual({ preference: "system", resolved: "dark" });
  });

  it("respects the cookie when present (overrides DB)", async () => {
    // Even with a signed-in user whose DB row says 'dark', the
    // cookie wins because it reflects the most recent change.
    const r = await createCredentialsUser({
      email: "cookie-wins@example.com",
      password: "password123",
      name: "Cookie",
    });
    if (!r.ok) throw new Error(r.error);
    await db
      .update(schema.users)
      .set({ themePreference: "dark" })
      .where(eq(schema.users.id, r.user.id));

    cookieValue = "light";
    mockAuth.mockResolvedValueOnce({ user: { id: r.user.id } });

    const result = await resolveTheme();
    expect(result.preference).toBe("light");
    expect(result.resolved).toBe("light");
  });

  it("falls back to the DB when no cookie is set", async () => {
    const r = await createCredentialsUser({
      email: "db-fallback@example.com",
      password: "password123",
      name: "DB",
    });
    if (!r.ok) throw new Error(r.error);
    await db
      .update(schema.users)
      .set({ themePreference: "dark" })
      .where(eq(schema.users.id, r.user.id));

    mockAuth.mockResolvedValueOnce({ user: { id: r.user.id } });

    const result = await resolveTheme();
    expect(result.preference).toBe("dark");
    expect(result.resolved).toBe("dark");
  });

  it("ignores an invalid cookie value", async () => {
    cookieValue = "neon-pink";
    mockAuth.mockResolvedValueOnce(null);

    const result = await resolveTheme();
    // Falls through to default since neither cookie nor session
    // produced a valid preference.
    expect(result.preference).toBe("system");
  });

  it("resolves 'system' to 'light' when the client hint says light", async () => {
    cookieValue = "system";
    headerHint = "light";
    mockAuth.mockResolvedValueOnce(null);

    const result = await resolveTheme();
    expect(result.preference).toBe("system");
    expect(result.resolved).toBe("light");
  });

  it("resolves 'system' to 'dark' when the client hint says dark", async () => {
    cookieValue = "system";
    headerHint = "dark";
    mockAuth.mockResolvedValueOnce(null);

    const result = await resolveTheme();
    expect(result.preference).toBe("system");
    expect(result.resolved).toBe("dark");
  });
});
