/**
 * Integration tests for `src/lib/admin/users-queries.ts` (Phase 2).
 *
 * Covers:
 *   - `listUsers` filter behavior (status, country, date range, sort,
 *     search), pagination, and the lifetime/last-activity joins.
 *   - `getUserDetail` shape, lifetime stats, and the note-with-author
 *     join.
 *
 * Schema reset between tests is the canonical pattern from
 * `tests/db/helpers.ts` so the lateral aggregates always run against
 * a known cohort.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import {
  DEFAULT_FILTERS,
  getUserDetail,
  listUsers,
  type ListUsersFilters,
} from "@/lib/admin/users-queries";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

// Pinned "now" inside the 30-day default filter window so seeded
// rows always fall within the date-range filter unless the test
// pushes them outside intentionally.
const NOW = new Date("2026-05-17T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const withDefaults = (overrides: Partial<ListUsersFilters>): ListUsersFilters => ({
  ...DEFAULT_FILTERS,
  // Phase-2 default is "30d"; widen to "all" for tests that span
  // older rows so we don't have to keep stuffing recent timestamps.
  dateRange: "all",
  // Pin "now" so date-range filters are evaluated relative to our
  // fixed NOW constant, not real wall-clock time.
  now: NOW,
  ...overrides,
});

async function seedUser(args: {
  email: string;
  createdAt?: Date;
  signupCountryCode?: string | null;
  signupSubdivisionCode?: string | null;
  displayName?: string | null;
  isAdmin?: boolean;
}): Promise<string> {
  const created = args.createdAt ?? NOW;
  const [row] = await db
    .insert(schema.users)
    .values({
      email: args.email,
      name: args.displayName ?? null,
      createdAt: created,
      updatedAt: created,
      signupCountryCode: args.signupCountryCode ?? null,
      signupSubdivisionCode: args.signupSubdivisionCode ?? null,
      isAdmin: args.isAdmin ?? false,
    })
    .returning({ id: schema.users.id });
  return row!.id;
}

async function seedPurchase(args: {
  userId: string;
  status: "pending" | "succeeded" | "failed";
  amountPaise: number;
  packType?: "starter" | "standard" | "heavy";
  createdAt?: Date;
  paymentId?: string;
}): Promise<string> {
  const created = args.createdAt ?? NOW;
  const [row] = await db
    .insert(schema.creditPurchases)
    .values({
      userId: args.userId,
      packType: args.packType ?? "starter",
      creditsPurchased: 5,
      amountPaidPaise: args.amountPaise,
      gstAmountPaise: Math.floor((args.amountPaise * 18) / 118),
      txnId: `txn_${args.userId}_${created.getTime()}_${Math.random()}`,
      txnRef: args.paymentId ?? null,
      status: args.status,
      createdAt: created,
    })
    .returning({ id: schema.creditPurchases.id });
  return row!.id;
}

async function seedSession(args: {
  userId: string;
  state?: "complete" | "failed" | "review" | "created";
  createdAt?: Date;
}): Promise<string> {
  const created = args.createdAt ?? NOW;
  const [row] = await db
    .insert(schema.interviewSessions)
    .values({
      userId: args.userId,
      companyName: "Acme",
      roleTitle: "Engineer",
      level: "senior",
      roundType: "behavioral",
      state: args.state ?? "complete",
      consentAffirmedAt: created,
      createdAt: created,
      updatedAt: created,
    })
    .returning({ id: schema.interviewSessions.id });
  return row!.id;
}

async function seedAudit(userId: string, eventType: string, createdAt: Date) {
  await db.insert(schema.auditLog).values({
    userId,
    eventType,
    eventData: {},
    createdAt,
  });
}

describe("listUsers", () => {
  it("returns lifetime spend, sessions count, and geo fields", async () => {
    const u = await seedUser({
      email: "amit@example.com",
      displayName: "Amit",
      signupCountryCode: "IN",
      signupSubdivisionCode: "MH",
    });
    await seedPurchase({ userId: u, status: "succeeded", amountPaise: 50_000 });
    await seedPurchase({ userId: u, status: "succeeded", amountPaise: 100_000, packType: "heavy" });
    // A failed purchase MUST NOT count toward lifetime spend.
    await seedPurchase({ userId: u, status: "failed", amountPaise: 999_999 });
    await seedSession({ userId: u });
    await seedSession({ userId: u });

    const result = await listUsers(withDefaults({}));
    expect(result.totalCount).toBe(1);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.email).toBe("amit@example.com");
    expect(row.displayName).toBe("Amit");
    expect(row.signupCountryCode).toBe("IN");
    expect(row.signupSubdivisionCode).toBe("MH");
    expect(row.totalSpentInr).toBe(1500);
    expect(row.sessionsCount).toBe(2);
    // Heavy outranks starter, so "highest pack" should resolve to heavy.
    expect(row.highestPack).toBe("heavy");
  });

  it("filters status=paying to users with at least one succeeded purchase", async () => {
    const paying = await seedUser({ email: "p@example.com" });
    await seedPurchase({ userId: paying, status: "succeeded", amountPaise: 50_000 });

    const freeUser = await seedUser({ email: "f@example.com" });
    void freeUser;

    const result = await listUsers(withDefaults({ status: "paying" }));
    expect(result.rows.map((r) => r.email)).toEqual(["p@example.com"]);
  });

  it("filters status=free to users with no succeeded purchases", async () => {
    const paying = await seedUser({ email: "p@example.com" });
    await seedPurchase({ userId: paying, status: "succeeded", amountPaise: 50_000 });

    await seedUser({ email: "f@example.com" });

    const result = await listUsers(withDefaults({ status: "free" }));
    expect(result.rows.map((r) => r.email)).toEqual(["f@example.com"]);
  });

  it("filters country=non_india to users with non-India country codes only", async () => {
    await seedUser({ email: "in@example.com", signupCountryCode: "IN" });
    await seedUser({ email: "us@example.com", signupCountryCode: "US" });
    await seedUser({ email: "uk@example.com", signupCountryCode: "GB" });
    await seedUser({ email: "anon@example.com", signupCountryCode: null });

    const result = await listUsers(withDefaults({ country: "non_india" }));
    expect(result.rows.map((r) => r.email).sort()).toEqual([
      "uk@example.com",
      "us@example.com",
    ]);
  });

  it("filters by date range (signed up in last 7 days)", async () => {
    await seedUser({
      email: "old@example.com",
      createdAt: new Date(NOW.getTime() - 30 * DAY),
    });
    await seedUser({
      email: "new@example.com",
      createdAt: new Date(NOW.getTime() - 3 * DAY),
    });

    const result = await listUsers(withDefaults({ dateRange: "7d" }));
    // Date-range filter uses real wall time; the 30-day-old row is
    // definitely outside the 7-day window, the 3-day-old one is
    // inside.
    expect(result.rows.map((r) => r.email)).toContain("new@example.com");
    expect(result.rows.map((r) => r.email)).not.toContain("old@example.com");
  });

  it("performs ILIKE search across email and display_name", async () => {
    await seedUser({ email: "alice@example.com", displayName: "Alice" });
    await seedUser({ email: "bob@example.com", displayName: "BOB" });

    const byEmail = await listUsers(withDefaults({ search: "alice" }));
    expect(byEmail.rows.map((r) => r.email)).toEqual(["alice@example.com"]);

    const byNameCaseInsensitive = await listUsers(withDefaults({ search: "bo" }));
    expect(byNameCaseInsensitive.rows.map((r) => r.email)).toEqual([
      "bob@example.com",
    ]);
  });

  it("escapes ILIKE special chars so the search isn't a wildcard", async () => {
    await seedUser({ email: "literal_underscore@example.com" });
    await seedUser({ email: "literalXunderscore@example.com" });

    // Without escaping, `_` would match any single character and
    // both rows would come back. With escaping, only the first
    // matches.
    const result = await listUsers(withDefaults({ search: "literal_underscore" }));
    expect(result.rows.map((r) => r.email)).toEqual([
      "literal_underscore@example.com",
    ]);
  });

  it("sorts by highest_spend with descending lifetime totals", async () => {
    const big = await seedUser({ email: "big@example.com" });
    const med = await seedUser({ email: "med@example.com" });
    const none = await seedUser({ email: "none@example.com" });
    void none;
    await seedPurchase({ userId: big, status: "succeeded", amountPaise: 500_000 });
    await seedPurchase({ userId: med, status: "succeeded", amountPaise: 100_000 });

    const result = await listUsers(withDefaults({ sort: "highest_spend" }));
    expect(result.rows.map((r) => r.email)).toEqual([
      "big@example.com",
      "med@example.com",
      "none@example.com",
    ]);
  });

  it("paginates: page=1 + page=2 return disjoint sets that cover the whole cohort", async () => {
    // Seed PAGE_SIZE + 1 users so the second page has exactly one row.
    for (let i = 0; i < 51; i += 1) {
      await seedUser({
        email: `u${String(i).padStart(2, "0")}@example.com`,
        createdAt: new Date(NOW.getTime() - i * 60_000),
      });
    }

    const page1 = await listUsers(withDefaults({ page: 1 }));
    const page2 = await listUsers(withDefaults({ page: 2 }));
    expect(page1.rows).toHaveLength(50);
    expect(page2.rows).toHaveLength(1);
    expect(page1.totalCount).toBe(51);
    expect(page2.totalCount).toBe(51);

    const emails = new Set([
      ...page1.rows.map((r) => r.email),
      ...page2.rows.map((r) => r.email),
    ]);
    expect(emails.size).toBe(51);
  });

  it("skips soft-deleted users entirely", async () => {
    const live = await seedUser({ email: "live@example.com" });
    void live;
    const deletedId = await seedUser({ email: "gone@example.com" });
    await db
      .update(schema.users)
      .set({ deletedAt: new Date() })
      .where(eq(schema.users.id, deletedId));

    const result = await listUsers(withDefaults({}));
    expect(result.rows.map((r) => r.email)).toEqual(["live@example.com"]);
  });
});

describe("getUserDetail", () => {
  it("returns null for a soft-deleted user", async () => {
    const id = await seedUser({ email: "gone@example.com" });
    await db
      .update(schema.users)
      .set({ deletedAt: new Date() })
      .where(eq(schema.users.id, id));

    const detail = await getUserDetail(id);
    expect(detail).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    const detail = await getUserDetail("00000000-0000-0000-0000-000000000000");
    expect(detail).toBeNull();
  });

  it("aggregates lifetime stats: sessions, credits purchased, credits used, total spent", async () => {
    const id = await seedUser({
      email: "u@example.com",
      signupCountryCode: "IN",
      signupSubdivisionCode: "KA",
    });

    await seedPurchase({
      userId: id,
      status: "succeeded",
      amountPaise: 50_000,
    });
    await seedPurchase({
      userId: id,
      status: "failed",
      amountPaise: 999_999,
    });
    await seedSession({ userId: id });
    await seedSession({ userId: id, state: "failed" });

    // Manual ledger inserts: simulate credit consumption.
    await db.insert(schema.creditTransactions).values({
      userId: id,
      delta: -3,
      balanceAfter: 7,
      reason: "interview_charge",
    });

    const detail = await getUserDetail(id);
    expect(detail).not.toBeNull();
    expect(detail!.signupCountryCode).toBe("IN");
    expect(detail!.signupSubdivisionCode).toBe("KA");
    expect(detail!.lifetime.sessionsCount).toBe(2);
    // Two sessions seeded but only the succeeded purchase counts toward credits.
    expect(detail!.lifetime.creditsPurchased).toBe(5);
    expect(detail!.lifetime.creditsUsed).toBe(3);
    expect(detail!.lifetime.totalSpentInr).toBe(500);
    expect(detail!.payments).toHaveLength(2);
    expect(detail!.sessions).toHaveLength(2);
  });

  it("joins admin notes to their author and orders newest-first", async () => {
    const target = await seedUser({ email: "target@example.com" });
    const admin = await seedUser({
      email: "admin@example.com",
      displayName: "Founder",
      isAdmin: true,
    });

    const older = new Date(NOW.getTime() - 5 * DAY);
    const newer = new Date(NOW.getTime() - DAY);

    await db.insert(schema.adminNotes).values({
      userId: target,
      adminId: admin,
      note: "Older note",
      createdAt: older,
    });
    await db.insert(schema.adminNotes).values({
      userId: target,
      adminId: admin,
      note: "Newer note",
      createdAt: newer,
    });

    const detail = await getUserDetail(target);
    expect(detail!.notes.map((n) => n.note)).toEqual(["Newer note", "Older note"]);
    expect(detail!.notes[0]!.adminEmail).toBe("admin@example.com");
    expect(detail!.notes[0]!.adminName).toBe("Founder");
  });

  it("computes lastActivityAt as max(audit_log.created_at) and falls back to signup", async () => {
    const id = await seedUser({
      email: "u@example.com",
      createdAt: new Date(NOW.getTime() - 10 * DAY),
    });
    await seedAudit(id, "user_logged_in", new Date(NOW.getTime() - 2 * DAY));
    await seedAudit(id, "session_created", new Date(NOW.getTime() - 4 * DAY));

    const detail = await getUserDetail(id);
    expect(detail!.lastActivityAt.getTime()).toBe(new Date(NOW.getTime() - 2 * DAY).getTime());

    const noActivityUser = await seedUser({
      email: "fresh@example.com",
      createdAt: new Date(NOW.getTime() - 1 * DAY),
    });
    const fresh = await getUserDetail(noActivityUser);
    expect(fresh!.lastActivityAt.getTime()).toBe(fresh!.signedUpAt.getTime());
  });
});

