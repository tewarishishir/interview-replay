/**
 * `getActiveUserId` is the bridge between the JWT cookie and the
 * "is this user still allowed?" gate that protects every write
 * endpoint. The (app) layout has the same logic via
 * `getDashboardUser`; this helper centralizes the rule so server
 * actions and API routes can call one function instead of
 * duplicating the soft-delete check.
 *
 * Covered here:
 *   - returns null when `auth()` has no session
 *   - returns null when the JWT is valid but `users.deleted_at IS NOT NULL`
 *     (the revocation gap that would otherwise let a soft-deleted
 *     user keep writing for the rest of their token's lifetime)
 *   - returns the userId for an active user
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

import { db, schema } from "@/lib/db";
import { getActiveUserId } from "@/lib/auth/session";
import { createCredentialsUser } from "@/lib/auth/users";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  mockAuth.mockReset();
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

const seedActiveUser = async (email = "alice@example.com") => {
  const result = await createCredentialsUser({
    email,
    password: "password123",
    name: "Alice",
  });
  if (!result.ok) throw new Error(`seedActiveUser failed: ${result.error}`);
  return result.user;
};

describe("getActiveUserId", () => {
  it("returns null when auth() has no session", async () => {
    mockAuth.mockResolvedValue(null);
    expect(await getActiveUserId()).toBeNull();
  });

  it("returns null when auth() has a session without user.id", async () => {
    mockAuth.mockResolvedValue({ user: { email: "x" } });
    expect(await getActiveUserId()).toBeNull();
  });

  it("returns null when the user has been soft-deleted", async () => {
    const user = await seedActiveUser();
    mockAuth.mockResolvedValue({ user: { id: user.id } });

    // Soft-delete the user — the JWT remains valid because the
    // session strategy is stateless, but the helper MUST notice.
    await db
      .update(schema.users)
      .set({ deletedAt: new Date() })
      .where(eq(schema.users.id, user.id));

    expect(await getActiveUserId()).toBeNull();
  });

  it("returns null for a session pointing at a non-existent user (post-hard-delete)", async () => {
    // A hard delete is unusual (we soft-delete by default) but we
    // must still tolerate a JWT whose `sub` no longer maps to a row.
    mockAuth.mockResolvedValue({
      user: { id: "00000000-0000-4000-a000-000000000000" },
    });
    expect(await getActiveUserId()).toBeNull();
  });

  it("returns the userId for an active (non-deleted) user", async () => {
    const user = await seedActiveUser();
    mockAuth.mockResolvedValue({ user: { id: user.id } });
    expect(await getActiveUserId()).toBe(user.id);
  });
});
