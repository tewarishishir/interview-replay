/**
 * Tests for `src/lib/admin/auth.ts`.
 *
 * Covers the three branches of `getAdminUser`:
 *   1. No session → null
 *   2. Session present, user exists, is_admin=false → null
 *      (this is the "redirect to /dashboard with no banner" case
 *      the layout takes for an authenticated non-admin)
 *   3. Session present, user exists, is_admin=true → admin user object
 *   4. Session present, user soft-deleted → null
 *
 * Also asserts that the function NEVER throws on a DB error path —
 * it returns `null` so the layout can degrade to /dashboard rather
 * than 500.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db, schema } from "@/lib/db";
import type * as AdminAuth from "@/lib/admin/auth";

import { ensureSchema, resetDatabase } from "../db/helpers";

const sessionMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => sessionMock(),
}));

let getAdminUser: (typeof AdminAuth)["getAdminUser"];

beforeAll(async () => {
  await ensureSchema();
  // Import after the mock is set up.
  const mod = await import("@/lib/admin/auth");
  getAdminUser = mod.getAdminUser;
});

beforeEach(async () => {
  await resetDatabase();
  sessionMock.mockReset();
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

describe("getAdminUser", () => {
  it("returns null when there's no session", async () => {
    sessionMock.mockResolvedValue(null);
    expect(await getAdminUser()).toBeNull();
  });

  it("returns null for an authenticated non-admin user", async () => {
    const [row] = await db
      .insert(schema.users)
      .values({ email: "regular@example.com", isAdmin: false })
      .returning({ id: schema.users.id });
    sessionMock.mockResolvedValue({ user: { id: row!.id } });
    expect(await getAdminUser()).toBeNull();
  });

  it("returns the admin object when is_admin=true", async () => {
    const [row] = await db
      .insert(schema.users)
      .values({
        email: "founder@example.com",
        name: "Founder",
        isAdmin: true,
      })
      .returning({ id: schema.users.id });
    sessionMock.mockResolvedValue({ user: { id: row!.id } });
    const result = await getAdminUser();
    expect(result).toEqual({
      id: row!.id,
      email: "founder@example.com",
      name: "Founder",
    });
  });

  it("returns null for a soft-deleted admin", async () => {
    const [row] = await db
      .insert(schema.users)
      .values({
        email: "gone@example.com",
        isAdmin: true,
        deletedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    sessionMock.mockResolvedValue({ user: { id: row!.id } });
    expect(await getAdminUser()).toBeNull();
  });

  it("returns null when auth() throws (a bad cookie, expired secret, etc.)", async () => {
    sessionMock.mockRejectedValue(new Error("bad cookie"));
    expect(await getAdminUser()).toBeNull();
  });
});
