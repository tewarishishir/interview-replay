/**
 * Integration tests for `listCreditTransactions` — the read-side
 * helper that powers the `/credits/history` page.
 *
 * Coverage:
 *   - Newest-first ordering.
 *   - Tenancy isolation: a second user's ledger rows must NOT leak.
 *   - Joined session data (companyName / roleTitle).
 *   - Joined purchase data (packType / amountPaidPaise).
 *   - Rows with no related session AND no related purchase
 *     (`rebuild_critique_charge`) come back with both `relatedSession`
 *     and `relatedPurchase === null` — that's the surface the UI
 *     uses to render "Practice rebuild critique" with no link.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";
import {
  chargeRebuildCritique,
  listAiUnitCharges,
  listCreditTransactions,
  REBUILD_CRITIQUE_CREDIT_COST,
  REBUILD_CRITIQUE_UNITS_PER_CREDIT,
} from "@/lib/credits";

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

const seedUser = async (email = "alice@example.com") => {
  const result = await createCredentialsUser({
    email,
    password: "password123",
    name: "Alice",
  });
  if (!result.ok) throw new Error(`seedUser failed: ${result.error}`);
  return result.user;
};

const seedSession = async (
  userId: string,
  companyName = "Stripe",
  roleTitle = "Backend Engineer",
) => {
  return createSession({
    userId,
    companyName,
    roleTitle,
    level: "senior",
    roundType: "coding",
    scheduledAt: null,
  });
};

const seedPurchase = async (userId: string) => {
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 12);
  const [row] = await db
    .insert(schema.creditPurchases)
    .values({
      userId,
      packType: "standard",
      creditsPurchased: 12,
      amountPaidPaise: 2900,
      // Transaction IDs are unique per row; use a per-test
      // pseudo-id so two seeds in one test don't collide on the
      // unique constraint.
      txnId: `pi_test_${Math.random().toString(36).slice(2)}`,
      status: "succeeded",
      expiresAt,
    })
    .returning({ id: schema.creditPurchases.id });
  if (!row) throw new Error("seedPurchase failed");
  return row;
};

describe("listCreditTransactions", () => {
  it("includes the signup-bonus ledger row written at user creation", async () => {
    // `createCredentialsUser` writes a `signup_bonus` ledger row as
    // part of the same transaction that creates the user. The
    // history page MUST surface that — otherwise the user sees a
    // non-zero balance with no explanation. Pinning this in a test
    // because it's the one row we don't insert manually.
    const user = await seedUser();

    const items = await listCreditTransactions({ userId: user.id });
    expect(items).toHaveLength(1);
    expect(items[0]?.reason).toBe("signup_bonus");
    expect(items[0]?.delta).toBeGreaterThan(0);
    expect(items[0]?.relatedSession).toBeNull();
    expect(items[0]?.relatedPurchase).toBeNull();
  });

  it("returns rows newest-first with session details joined", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id, "Stripe", "Backend Engineer");

    // Two charges, second one wins on createdAt (the second insert
    // wins by sequence id even when timestamps round to the same ms).
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: -2,
      balanceAfter: 8,
      reason: "interview_charge",
      relatedSessionId: session.id,
    });
    // Force a different timestamp so ordering is unambiguous even if
    // the sequence id ordering ever changes.
    await new Promise((r) => setTimeout(r, 10));
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: -1,
      balanceAfter: 7,
      reason: "interview_charge",
      relatedSessionId: session.id,
    });

    const all = await listCreditTransactions({ userId: user.id });
    // Filter the seed-time signup_bonus out so the assertions below
    // describe ONLY the rows this test wrote.
    const items = all.filter((item) => item.reason === "interview_charge");
    expect(items).toHaveLength(2);
    expect(items[0]?.delta).toBe(-1);
    expect(items[1]?.delta).toBe(-2);
    expect(items[0]?.relatedSession).toEqual({
      id: session.id,
      companyName: "Stripe",
      roleTitle: "Backend Engineer",
    });
    expect(items[0]?.relatedPurchase).toBeNull();

    // Newest-first across the full list — the two interview_charge
    // rows must come BEFORE the seed-time signup_bonus row.
    expect(all[all.length - 1]?.reason).toBe("signup_bonus");
  });

  it("joins purchase rows on `relatedPurchaseId`", async () => {
    const user = await seedUser();
    const purchase = await seedPurchase(user.id);

    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 12,
      balanceAfter: 12,
      reason: "purchase",
      relatedPurchaseId: purchase.id,
    });

    const items = await listCreditTransactions({ userId: user.id });
    const purchaseRow = items.find((item) => item.reason === "purchase");
    expect(purchaseRow).toBeDefined();
    expect(purchaseRow?.relatedPurchase).toEqual({
      id: purchase.id,
      packType: "standard",
      creditsPurchased: 12,
      amountPaidPaise: 2900,
    });
    expect(purchaseRow?.relatedSession).toBeNull();
  });

  it("returns null for both joins on rebuild_critique_charge rows", async () => {
    const user = await seedUser();
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: -1,
      balanceAfter: 9,
      reason: "rebuild_critique_charge",
    });

    const items = await listCreditTransactions({ userId: user.id });
    const critique = items.find(
      (item) => item.reason === "rebuild_critique_charge",
    );
    expect(critique).toBeDefined();
    expect(critique?.relatedSession).toBeNull();
    expect(critique?.relatedPurchase).toBeNull();
  });

  it("does not leak another user's ledger rows", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    const aliceSession = await seedSession(alice.id);

    await db.insert(schema.creditTransactions).values([
      {
        userId: alice.id,
        delta: -1,
        balanceAfter: 9,
        reason: "interview_charge",
        relatedSessionId: aliceSession.id,
      },
      {
        userId: bob.id,
        delta: 5,
        balanceAfter: 5,
        reason: "admin_adjustment",
      },
    ]);

    const aliceItems = await listCreditTransactions({ userId: alice.id });
    // Alice should see her signup_bonus + her interview_charge, but
    // never any of bob's rows.
    expect(aliceItems.every((item) => item.reason !== "admin_adjustment")).toBe(
      true,
    );
    expect(
      aliceItems.some(
        (item) =>
          item.reason === "interview_charge" &&
          item.relatedSession?.id === aliceSession.id,
      ),
    ).toBe(true);

    const bobItems = await listCreditTransactions({ userId: bob.id });
    expect(bobItems.some((item) => item.reason === "admin_adjustment")).toBe(
      true,
    );
    expect(
      bobItems.some(
        (item) => item.relatedSession?.id === aliceSession.id,
      ),
    ).toBe(false);
  });

  it("respects the limit parameter (clamped to [1, 500])", async () => {
    const user = await seedUser();
    for (let i = 0; i < 5; i += 1) {
      await db.insert(schema.creditTransactions).values({
        userId: user.id,
        delta: 1,
        balanceAfter: i + 1,
        reason: "admin_adjustment",
      });
    }

    const items = await listCreditTransactions({ userId: user.id, limit: 2 });
    expect(items).toHaveLength(2);
  });

  it("survives a hard-deleted related session (FK set null)", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);

    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: -1,
      balanceAfter: 9,
      reason: "interview_charge",
      relatedSessionId: session.id,
    });

    // Hard-delete the session row; the FK is `ON DELETE SET NULL`,
    // so the ledger row stays but the join evaporates.
    await db
      .delete(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));

    const items = await listCreditTransactions({ userId: user.id });
    const charge = items.find((item) => item.reason === "interview_charge");
    expect(charge).toBeDefined();
    expect(charge?.relatedSession).toBeNull();
  });
});

describe("listAiUnitCharges", () => {
  // The per-call 0.20-credit deductions don't write to the integer
  // ledger — they live in `audit_log` as `*.unit_charged` events.
  // The credits-history page merges these with the ledger so the
  // user sees every paid AI call. These tests pin the read contract.

  const seedRebuild = async (userId: string) => {
    const [row] = await db
      .insert(schema.storyRebuilds)
      .values({ userId, questionText: "test q" })
      .returning();
    if (!row) throw new Error("seedRebuild: no row");
    return row;
  };

  it("returns one row per AI call, newest-first", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);

    // Three non-rollover calls — same surface, three audit rows.
    for (let i = 0; i < 3; i += 1) {
      await chargeRebuildCritique({ userId: user.id, rebuildId: rebuild.id });
      // Tiny pause so createdAt is strictly ordered.
      await new Promise((r) => setTimeout(r, 5));
    }

    const items = await listAiUnitCharges({ userId: user.id });
    expect(items).toHaveLength(3);
    expect(items[0]?.surface).toBe("rebuild_critique");
    expect(items[0]?.creditCost).toBeCloseTo(REBUILD_CRITIQUE_CREDIT_COST, 6);
    // Newest-first: the last write should be at index 0.
    expect(items[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(
      items[1]!.createdAt.getTime(),
    );
    expect(items[1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
      items[2]!.createdAt.getTime(),
    );
  });

  it("includes the Nth (rollover) call and flags it as rolledOver=true", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);

    for (let i = 0; i < REBUILD_CRITIQUE_UNITS_PER_CREDIT; i += 1) {
      await chargeRebuildCritique({ userId: user.id, rebuildId: rebuild.id });
    }

    const items = await listAiUnitCharges({ userId: user.id });
    expect(items).toHaveLength(REBUILD_CRITIQUE_UNITS_PER_CREDIT);
    const rolledOver = items.filter((i) => i.rolledOver);
    expect(rolledOver).toHaveLength(1);
  });

  it("attributes each surface correctly", async () => {
    const user = await seedUser();
    await db
      .update(schema.users)
      .set({ creditBalance: 0 })
      .where(eq(schema.users.id, user.id));

    await chargeRebuildCritique({
      userId: user.id,
      surface: { kind: "rebuild_suggest", rebuildId: "r-1" },
    });
    await chargeRebuildCritique({
      userId: user.id,
      surface: { kind: "story_suggest", storyId: "s-1" },
    });
    await chargeRebuildCritique({
      userId: user.id,
      surface: { kind: "story_draft" },
    });

    const items = await listAiUnitCharges({ userId: user.id });
    const surfaces = items.map((i) => i.surface).sort();
    expect(surfaces).toEqual(["rebuild_suggest", "story_draft", "story_suggest"]);

    const rebuildRow = items.find((i) => i.surface === "rebuild_suggest");
    expect(rebuildRow?.rebuildId).toBe("r-1");
    expect(rebuildRow?.storyId).toBeNull();

    const storySuggestRow = items.find((i) => i.surface === "story_suggest");
    expect(storySuggestRow?.storyId).toBe("s-1");
    expect(storySuggestRow?.rebuildId).toBeNull();

    const storyDraftRow = items.find((i) => i.surface === "story_draft");
    expect(storyDraftRow?.rebuildId).toBeNull();
    expect(storyDraftRow?.storyId).toBeNull();
  });

  it("does not leak another user's AI usage rows", async () => {
    const alice = await seedUser("alice2@example.com");
    const bob = await seedUser("bob2@example.com");
    const aliceRebuild = await seedRebuild(alice.id);
    const bobRebuild = await seedRebuild(bob.id);

    await chargeRebuildCritique({
      userId: alice.id,
      rebuildId: aliceRebuild.id,
    });
    await chargeRebuildCritique({
      userId: bob.id,
      rebuildId: bobRebuild.id,
    });
    await chargeRebuildCritique({
      userId: bob.id,
      rebuildId: bobRebuild.id,
    });

    const aliceItems = await listAiUnitCharges({ userId: alice.id });
    const bobItems = await listAiUnitCharges({ userId: bob.id });
    expect(aliceItems).toHaveLength(1);
    expect(bobItems).toHaveLength(2);
  });
});
