/**
 * Integration tests for `PATCH /api/admin/feedback/[id]`.
 *
 * Mocks the admin auth boundary; hits the real Postgres for
 * persistence + audit log assertions. The transition matrix is
 * open (any → any) so we cover approve → reject → pending and
 * verify the approval-stamp columns + audit entries land
 * correctly at each step.
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
  "x-forwarded-for": "203.0.113.42",
  "user-agent": "vitest",
};
let headerOverride: Record<string, string> | null = null;
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerOverride ?? DEFAULT_HEADERS),
}));

const mockGetAdminUser = vi.fn();
vi.mock("@/lib/admin/auth", () => ({
  getAdminUser: () => mockGetAdminUser(),
}));

import { PATCH } from "@/app/api/admin/feedback/[id]/route";
import { createCredentialsUser } from "@/lib/auth/users";
import { db, schema } from "@/lib/db";
import { createFeedback } from "@/lib/feedback/persist";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  mockGetAdminUser.mockReset();
  headerOverride = null;
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

const seedUser = async (
  email = "alice@example.com",
  opts: { isAdmin?: boolean } = {},
) => {
  const r = await createCredentialsUser({
    email,
    password: "password123",
    name: "Alice",
  });
  if (!r.ok) throw new Error(`seedUser failed: ${r.error}`);
  if (opts.isAdmin) {
    await db
      .update(schema.users)
      .set({ isAdmin: true })
      .where(eq(schema.users.id, r.user.id));
  }
  return r.user;
};

const seedFeedback = async (userId: string) =>
  createFeedback({
    userId,
    data: {
      rating: 4,
      message: "Pretty solid.",
      consentPublic: true,
      displayName: "Priya R.",
      displayRole: "Senior PM",
      pagePath: "/dashboard",
    },
  });

const jsonRequest = (body: unknown): Request =>
  new Request("http://localhost:3000/api/admin/feedback/x", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify(body),
  });

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("PATCH /api/admin/feedback/[id]", () => {
  it("404s when the caller isn't an admin (disclosure-minimizing)", async () => {
    mockGetAdminUser.mockResolvedValue(null);
    const res = await PATCH(
      jsonRequest({ status: "approved" }),
      ctx("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
  });

  it("404s when the row doesn't exist", async () => {
    const admin = await seedUser("admin@example.com", { isAdmin: true });
    mockGetAdminUser.mockResolvedValue({
      id: admin.id,
      email: admin.email,
      name: admin.name,
    });

    const res = await PATCH(
      jsonRequest({ status: "approved" }),
      ctx("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
  });

  it("400s on an invalid status value", async () => {
    const admin = await seedUser("admin@example.com", { isAdmin: true });
    const submitter = await seedUser("user@example.com");
    const row = await seedFeedback(submitter.id);
    mockGetAdminUser.mockResolvedValue({
      id: admin.id,
      email: admin.email,
      name: admin.name,
    });

    const res = await PATCH(
      jsonRequest({ status: "wishlisted" }),
      ctx(row.id),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      fieldErrors: Record<string, string>;
    };
    expect(body.fieldErrors.status).toBeDefined();
  });

  it("approves a pending row, stamps approval columns, writes an audit entry", async () => {
    const admin = await seedUser("admin@example.com", { isAdmin: true });
    const submitter = await seedUser("user@example.com");
    const row = await seedFeedback(submitter.id);
    mockGetAdminUser.mockResolvedValue({
      id: admin.id,
      email: admin.email,
      name: admin.name,
    });

    const res = await PATCH(
      jsonRequest({ status: "approved", adminNotes: "Great quote." }),
      ctx(row.id),
    );
    expect(res.status).toBe(200);

    const [updated] = await db
      .select()
      .from(schema.feedback)
      .where(eq(schema.feedback.id, row.id));
    expect(updated!.status).toBe("approved");
    expect(updated!.approvedAt).toBeInstanceOf(Date);
    expect(updated!.approvedByUserId).toBe(admin.id);
    expect(updated!.adminNotes).toBe("Great quote.");

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, admin.id));
    const approved = audit.find(
      (r) => r.eventType === "admin_action.feedback_approved",
    );
    expect(approved).toBeDefined();
    const data = approved!.eventData as Record<string, unknown>;
    expect(data.targetUserId).toBe(submitter.id);
    expect((data.details as Record<string, unknown>).feedbackId).toBe(row.id);
    expect((data.details as Record<string, unknown>).previousStatus).toBe(
      "pending",
    );
    expect((data.details as Record<string, unknown>).newStatus).toBe(
      "approved",
    );
  });

  it("clears the approval stamp when reversed back to pending", async () => {
    const admin = await seedUser("admin@example.com", { isAdmin: true });
    const submitter = await seedUser("user@example.com");
    const row = await seedFeedback(submitter.id);
    mockGetAdminUser.mockResolvedValue({
      id: admin.id,
      email: admin.email,
      name: admin.name,
    });

    // Approve first.
    await PATCH(jsonRequest({ status: "approved" }), ctx(row.id));

    // Then reverse to pending.
    const res = await PATCH(jsonRequest({ status: "pending" }), ctx(row.id));
    expect(res.status).toBe(200);

    const [updated] = await db
      .select()
      .from(schema.feedback)
      .where(eq(schema.feedback.id, row.id));
    expect(updated!.status).toBe("pending");
    expect(updated!.approvedAt).toBeNull();
    expect(updated!.approvedByUserId).toBeNull();

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, admin.id));
    expect(
      audit.find(
        (r) => r.eventType === "admin_action.feedback_unreviewed",
      ),
    ).toBeDefined();
  });

  it("records a feedback_rejected audit event on a reject transition", async () => {
    const admin = await seedUser("admin@example.com", { isAdmin: true });
    const submitter = await seedUser("user@example.com");
    const row = await seedFeedback(submitter.id);
    mockGetAdminUser.mockResolvedValue({
      id: admin.id,
      email: admin.email,
      name: admin.name,
    });

    const res = await PATCH(
      jsonRequest({ status: "rejected" }),
      ctx(row.id),
    );
    expect(res.status).toBe(200);

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, admin.id));
    expect(
      audit.find(
        (r) => r.eventType === "admin_action.feedback_rejected",
      ),
    ).toBeDefined();
  });
});
