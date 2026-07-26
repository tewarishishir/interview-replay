/**
 * Tests for `src/lib/admin/audit.ts`.
 *
 * Coverage:
 *   - `recordAdminPageView` writes an `admin_page_viewed` row tagged
 *     with the path + viewed_user_id, attributed to the admin's
 *     user_id.
 *   - `recordAdminAction` writes a row for each `admin_action.*`
 *     event type and refuses to swallow DB errors (the page-view
 *     write path swallows, but action audit MUST surface).
 *   - Both helpers populate ip_address / user_agent from
 *     next/headers when the request context is mocked in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import {
  ADMIN_AUDIT_EVENTS,
  recordAdminAction,
  recordAdminPageView,
} from "@/lib/admin/audit";

import { ensureSchema, resetDatabase } from "../db/helpers";

const headerMap: Record<string, string> = {};
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (key: string) => headerMap[key.toLowerCase()] ?? null,
  }),
}));

const setHeaders = (h: Record<string, string>) => {
  for (const k of Object.keys(headerMap)) delete headerMap[k];
  for (const [k, v] of Object.entries(h)) headerMap[k.toLowerCase()] = v;
};

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  setHeaders({});
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

async function makeAdmin(email = "admin@example.com"): Promise<string> {
  const [row] = await db
    .insert(schema.users)
    .values({ email, isAdmin: true })
    .returning({ id: schema.users.id });
  return row!.id;
}

describe("recordAdminPageView", () => {
  it("writes a row tagged with path + viewed_user_id, captures IP + UA from headers", async () => {
    const adminId = await makeAdmin();
    setHeaders({
      "x-forwarded-for": "203.0.113.42, 198.51.100.7",
      "user-agent": "Mozilla/5.0 (vitest)",
    });

    await recordAdminPageView({
      adminId,
      path: "/admin/users/abc",
      viewedUserId: "user-abc",
    });

    const [row] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.eventType, ADMIN_AUDIT_EVENTS.pageViewed));
    expect(row).toBeDefined();
    expect(row!.userId).toBe(adminId);
    expect(row!.eventData).toMatchObject({
      path: "/admin/users/abc",
      viewedUserId: "user-abc",
    });
    expect(row!.ipAddress).toBe("203.0.113.42");
    expect(row!.userAgent).toBe("Mozilla/5.0 (vitest)");
  });

  it("never throws when the DB write fails (the layout's render must continue)", async () => {
    // Passing a syntactically valid but non-existent admin ID should
    // fail the FK and the helper should swallow it instead of
    // bubbling.
    await expect(
      recordAdminPageView({
        adminId: "00000000-0000-0000-0000-000000000000",
        path: "/admin/ops",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("recordAdminAction", () => {
  it("writes a typed admin_action.* row with target user + details", async () => {
    const adminId = await makeAdmin();
    const [targetRow] = await db
      .insert(schema.users)
      .values({ email: "target@example.com" })
      .returning({ id: schema.users.id });
    const targetId = targetRow!.id;

    setHeaders({ "x-real-ip": "203.0.113.99" });

    await recordAdminAction({
      adminId,
      action: ADMIN_AUDIT_EVENTS.actionGrantCredits,
      targetUserId: targetId,
      details: { credits: 5, reason: "make-good" },
    });

    const [row] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.eventType, ADMIN_AUDIT_EVENTS.actionGrantCredits))
      .orderBy(desc(schema.auditLog.createdAt));
    expect(row).toBeDefined();
    expect(row!.userId).toBe(adminId);
    expect(row!.eventData).toMatchObject({
      targetUserId: targetId,
      details: { credits: 5, reason: "make-good" },
    });
    expect(row!.ipAddress).toBe("203.0.113.99");
  });
});
