/**
 * Tests for the sub-credit accumulator that powers Practice Rebuild
 * critique charging.
 *
 * The product price is 0.20 credits per critique, but the credit
 * ledger and `users.credit_balance` are integer-only. The
 * accumulator on `users.rebuild_critique_units` rolls over every
 * `REBUILD_CRITIQUE_UNITS_PER_CREDIT` (5) calls, deducting one
 * whole credit and writing a `rebuild_critique_charge` ledger row.
 *
 * What we cover:
 *   - Critiques 1..(N-1) bump the counter, charge nothing, write
 *     no ledger row, and don't touch the balance.
 *   - The Nth critique rolls over: charges 1 credit, writes ONE
 *     `rebuild_critique_charge` row with delta=-1, resets the
 *     counter to 0.
 *   - Concurrent critiques against the same user serialize cleanly
 *     (no double-charge, no lost increment) — the FOR UPDATE on the
 *     user row is the load-bearing serializer.
 *   - Out-of-credits at rollover throws `InsufficientCreditsError`
 *     and writes nothing.
 *   - `previewRebuildCritiqueCost` correctly mirrors the would-roll
 *     and would-charge predicates without mutating state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import {
  chargeRebuildCritique,
  InsufficientCreditsError,
  previewRebuildCritiqueCost,
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

const seedRebuild = async (userId: string) => {
  const [row] = await db
    .insert(schema.storyRebuilds)
    .values({ userId, questionText: "test question" })
    .returning();
  if (!row) throw new Error("seedRebuild: no row returned");
  return row;
};

// Convenience: charge once with a stable per-test rebuild id so the
// audit log gets attribution but tests don't have to thread the id
// through every call.
const chargeOnce = async (userId: string, rebuildId: string) =>
  chargeRebuildCritique({ userId, rebuildId });

const setBalance = async (userId: string, balance: number) => {
  await db
    .update(schema.users)
    .set({ creditBalance: balance })
    .where(eq(schema.users.id, userId));
};

const setUnits = async (userId: string, units: number) => {
  await db
    .update(schema.users)
    .set({ rebuildCritiqueUnits: units })
    .where(eq(schema.users.id, userId));
};

const readUser = async (userId: string) => {
  const [row] = await db
    .select({
      creditBalance: schema.users.creditBalance,
      rebuildCritiqueUnits: schema.users.rebuildCritiqueUnits,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!row) throw new Error(`readUser: ${userId} not found`);
  return row;
};

const countLedgerRows = async (userId: string, reason: string) => {
  const rows = await db
    .select()
    .from(schema.creditTransactions)
    .where(eq(schema.creditTransactions.userId, userId));
  return rows.filter((r) => r.reason === reason).length;
};

describe("chargeRebuildCritique — accumulator", () => {
  it("bumps units and writes nothing for critiques 1..(N-1)", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);
    const initialBalance = (await readUser(user.id)).creditBalance;

    const callsBeforeRollover = REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1;
    for (let i = 0; i < callsBeforeRollover; i++) {
      const result = await chargeOnce(user.id, rebuild.id);
      expect(result.creditsCharged).toBe(0);
      expect(result.rolledOver).toBe(false);
      expect(result.unitsAfter).toBe(i + 1);
      expect(result.balanceAfter).toBe(initialBalance);
    }

    const after = await readUser(user.id);
    expect(after.rebuildCritiqueUnits).toBe(callsBeforeRollover);
    expect(after.creditBalance).toBe(initialBalance);

    // No `rebuild_critique_charge` ledger rows yet.
    const charges = await countLedgerRows(
      user.id,
      "rebuild_critique_charge",
    );
    expect(charges).toBe(0);
  });

  it("rolls over on the Nth critique: -1 credit, ledger row, units back to 0", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);
    const initialBalance = (await readUser(user.id)).creditBalance;

    let lastResult: Awaited<ReturnType<typeof chargeRebuildCritique>> | null =
      null;
    for (let i = 0; i < REBUILD_CRITIQUE_UNITS_PER_CREDIT; i++) {
      lastResult = await chargeOnce(user.id, rebuild.id);
    }

    expect(lastResult).not.toBeNull();
    expect(lastResult!.creditsCharged).toBe(1);
    expect(lastResult!.rolledOver).toBe(true);
    expect(lastResult!.unitsAfter).toBe(0);
    expect(lastResult!.balanceAfter).toBe(initialBalance - 1);

    const after = await readUser(user.id);
    expect(after.creditBalance).toBe(initialBalance - 1);
    expect(after.rebuildCritiqueUnits).toBe(0);

    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.userId, user.id));
    const charges = ledger.filter(
      (r) => r.reason === "rebuild_critique_charge",
    );
    expect(charges).toHaveLength(1);
    expect(charges[0]?.delta).toBe(-1);
    expect(charges[0]?.balanceAfter).toBe(initialBalance - 1);
    // The ledger column references interview_sessions, not story_rebuilds,
    // so the rollover row leaves the FK null. The rebuild attribution
    // lives on the audit_log row asserted below.
    expect(charges[0]?.relatedSessionId).toBeNull();
  });

  it("rollover writes a `rebuild_critique.credit_charged` audit row attributing the charge to the rebuild", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);

    for (let i = 0; i < REBUILD_CRITIQUE_UNITS_PER_CREDIT; i++) {
      await chargeOnce(user.id, rebuild.id);
    }

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));
    const charges = audit.filter(
      (r) => r.eventType === "rebuild_critique.credit_charged",
    );
    expect(charges).toHaveLength(1);
    const ev = charges[0]?.eventData as Record<string, unknown>;
    expect(ev.rebuildId).toBe(rebuild.id);
    expect(ev.unitsBeforeCharge).toBe(REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1);
    expect(ev.unitsAfterCharge).toBe(0);
    expect(ev.unitsPerCredit).toBe(REBUILD_CRITIQUE_UNITS_PER_CREDIT);
    expect(typeof ev.ledgerRowId).toBe("number");
  });

  it("two rollovers across 2*N critiques write exactly two ledger rows AND two audit rows", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);
    await setBalance(user.id, 10);

    for (let i = 0; i < 2 * REBUILD_CRITIQUE_UNITS_PER_CREDIT; i++) {
      await chargeOnce(user.id, rebuild.id);
    }

    const after = await readUser(user.id);
    expect(after.creditBalance).toBe(10 - 2);
    expect(after.rebuildCritiqueUnits).toBe(0);

    expect(
      await countLedgerRows(user.id, "rebuild_critique_charge"),
    ).toBe(2);

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));
    const audits = audit.filter(
      (r) => r.eventType === "rebuild_critique.credit_charged",
    );
    expect(audits).toHaveLength(2);
  });

  it("throws InsufficientCreditsError on rollover with zero balance and writes nothing", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);
    await setBalance(user.id, 0);
    // Right at the rollover boundary — next call is the Nth critique.
    await setUnits(user.id, REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1);

    await expect(
      chargeOnce(user.id, rebuild.id),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    const after = await readUser(user.id);
    expect(after.creditBalance).toBe(0);
    // Counter unchanged — the failed rollover must not advance state.
    expect(after.rebuildCritiqueUnits).toBe(
      REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1,
    );

    expect(
      await countLedgerRows(user.id, "rebuild_critique_charge"),
    ).toBe(0);

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));
    const audits = audit.filter(
      (r) => r.eventType === "rebuild_critique.credit_charged",
    );
    expect(audits).toHaveLength(0);
  });

  it("non-rollover charges DO NOT block on zero balance — sub-credit calls don't read it", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);
    await setBalance(user.id, 0);
    await setUnits(user.id, 0);

    const result = await chargeOnce(user.id, rebuild.id);
    expect(result.creditsCharged).toBe(0);
    expect(result.balanceAfter).toBe(0);
    expect(result.unitsAfter).toBe(1);
    expect(result.rolledOver).toBe(false);
  });

  it("concurrent critiques serialize cleanly under FOR UPDATE — no double-charge, no lost increment", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);
    await setBalance(user.id, 5);
    await setUnits(user.id, 0);

    const fanout = REBUILD_CRITIQUE_UNITS_PER_CREDIT * 2; // two rollovers
    const results = await Promise.all(
      Array.from({ length: fanout }, () =>
        chargeOnce(user.id, rebuild.id),
      ),
    );

    // Exactly two of the parallel calls should have rolled over.
    const rolloverCount = results.filter((r) => r.rolledOver).length;
    expect(rolloverCount).toBe(2);

    const after = await readUser(user.id);
    expect(after.creditBalance).toBe(5 - 2);
    expect(after.rebuildCritiqueUnits).toBe(0);

    expect(
      await countLedgerRows(user.id, "rebuild_critique_charge"),
    ).toBe(2);
  });

  it("refuses to charge a soft-deleted user (must not read past JWT expiry)", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);
    await db
      .update(schema.users)
      .set({ deletedAt: new Date() })
      .where(eq(schema.users.id, user.id));

    await expect(chargeOnce(user.id, rebuild.id)).rejects.toThrow(
      /not found or soft-deleted/,
    );
  });

  it("input validation: rejects empty userId / rebuildId", async () => {
    await expect(
      chargeRebuildCritique({ userId: "", rebuildId: "anything" }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      chargeRebuildCritique({ userId: "anything", rebuildId: "" }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rollover via `surface: rebuild_suggest` writes a `rebuild_suggest.credit_charged` audit row with rebuildId", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);

    for (let i = 0; i < REBUILD_CRITIQUE_UNITS_PER_CREDIT; i++) {
      await chargeRebuildCritique({
        userId: user.id,
        surface: { kind: "rebuild_suggest", rebuildId: rebuild.id },
      });
    }

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));
    const charges = audit.filter(
      (r) => r.eventType === "rebuild_suggest.credit_charged",
    );
    expect(charges).toHaveLength(1);
    const ev = charges[0]?.eventData as Record<string, unknown>;
    expect(ev.rebuildId).toBe(rebuild.id);
    // No `storyId` on the rebuild surfaces.
    expect(ev.storyId).toBeUndefined();
    // The legacy event_type should NOT have been written for
    // this surface — the cross-surface audit grep relies on it.
    expect(
      audit.filter((r) => r.eventType === "rebuild_critique.credit_charged"),
    ).toHaveLength(0);
  });

  it("rollover via `surface: story_suggest` writes a `story_suggest.credit_charged` audit row with storyId", async () => {
    const user = await seedUser();
    const storyId = "00000000-0000-4000-8000-000000000abc";

    for (let i = 0; i < REBUILD_CRITIQUE_UNITS_PER_CREDIT; i++) {
      await chargeRebuildCritique({
        userId: user.id,
        surface: { kind: "story_suggest", storyId },
      });
    }

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));
    const charges = audit.filter(
      (r) => r.eventType === "story_suggest.credit_charged",
    );
    expect(charges).toHaveLength(1);
    const ev = charges[0]?.eventData as Record<string, unknown>;
    expect(ev.storyId).toBe(storyId);
    expect(ev.rebuildId).toBeUndefined();
  });

  it("rollover via `surface: story_draft` writes a `story_draft.credit_charged` audit row with no entity id", async () => {
    const user = await seedUser();

    for (let i = 0; i < REBUILD_CRITIQUE_UNITS_PER_CREDIT; i++) {
      await chargeRebuildCritique({
        userId: user.id,
        surface: { kind: "story_draft" },
      });
    }

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));
    const charges = audit.filter(
      (r) => r.eventType === "story_draft.credit_charged",
    );
    expect(charges).toHaveLength(1);
    const ev = charges[0]?.eventData as Record<string, unknown>;
    // The form-time surface intentionally has no entity id.
    expect(ev.rebuildId).toBeUndefined();
    expect(ev.storyId).toBeUndefined();
    // Bookkeeping fields are still present.
    expect(typeof ev.ledgerRowId).toBe("number");
    expect(ev.unitsPerCredit).toBe(REBUILD_CRITIQUE_UNITS_PER_CREDIT);
  });

  it("rejects calls with neither `rebuildId` nor `surface`", async () => {
    const user = await seedUser();
    await expect(
      chargeRebuildCritique({ userId: user.id } as unknown as {
        userId: string;
      }),
    ).rejects.toThrow(/either `surface` or `rebuildId`/);
  });

  // -- Per-call `*.unit_charged` audit rows --
  //
  // Every paid AI call (rollover or not) writes a `*.unit_charged`
  // audit_log row so the user-facing credits history can render a
  // 0.20-credit deduction line item per call. These tests pin that
  // contract — drift here would silently un-do the per-call
  // visibility the `/credits/history` page now relies on.

  it("non-rollover calls write a `*.unit_charged` audit row with creditCost=0.20", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);

    const result = await chargeOnce(user.id, rebuild.id);
    expect(result.rolledOver).toBe(false);

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));

    const unitRows = audit.filter(
      (r) => r.eventType === "rebuild_critique.unit_charged",
    );
    expect(unitRows).toHaveLength(1);
    const ev = unitRows[0]?.eventData as Record<string, unknown>;
    expect(ev.creditCost).toBeCloseTo(
      1 / REBUILD_CRITIQUE_UNITS_PER_CREDIT,
      6,
    );
    expect(ev.rebuildId).toBe(rebuild.id);
    expect(ev.rolledOver).toBe(false);
    expect(ev.unitsBeforeCharge).toBe(0);
    expect(ev.unitsAfterCharge).toBe(1);
    expect(ev.balanceBefore).toBe(ev.balanceAfter);

    // Non-rollover must NOT write a credit_charged row — the ledger
    // and the rollover audit are reserved for the Nth call.
    const chargeRows = audit.filter(
      (r) => r.eventType === "rebuild_critique.credit_charged",
    );
    expect(chargeRows).toHaveLength(0);
  });

  it("N calls write N `*.unit_charged` rows AND exactly one `*.credit_charged` rollover row", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);

    for (let i = 0; i < REBUILD_CRITIQUE_UNITS_PER_CREDIT; i++) {
      await chargeOnce(user.id, rebuild.id);
    }

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));

    const unitRows = audit.filter(
      (r) => r.eventType === "rebuild_critique.unit_charged",
    );
    expect(unitRows).toHaveLength(REBUILD_CRITIQUE_UNITS_PER_CREDIT);

    // Exactly one of the N unit rows should mark rolledOver=true —
    // the Nth call. The earlier N-1 rows are non-rollover.
    const rolledOver = unitRows.filter(
      (r) => (r.eventData as Record<string, unknown>).rolledOver === true,
    );
    expect(rolledOver).toHaveLength(1);

    const chargeRows = audit.filter(
      (r) => r.eventType === "rebuild_critique.credit_charged",
    );
    expect(chargeRows).toHaveLength(1);
  });

  it("per-call audit rows use the right event_type for each surface", async () => {
    const user = await seedUser();
    await setBalance(user.id, 0);

    // One call on each non-rollover surface. The balance=0 guard
    // verifies sub-credit calls don't read the balance — these
    // should all succeed even with zero credits.
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

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));

    expect(
      audit.filter((r) => r.eventType === "rebuild_suggest.unit_charged"),
    ).toHaveLength(1);
    expect(
      audit.filter((r) => r.eventType === "story_suggest.unit_charged"),
    ).toHaveLength(1);
    expect(
      audit.filter((r) => r.eventType === "story_draft.unit_charged"),
    ).toHaveLength(1);
  });

  it("InsufficientCreditsError on rollover writes NO unit_charged row (atomic refusal)", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);
    await setBalance(user.id, 0);
    await setUnits(user.id, REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1);

    await expect(
      chargeOnce(user.id, rebuild.id),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));

    // The transaction rolled back — no audit rows at all for this
    // refused call, including the per-call unit_charged row.
    expect(
      audit.filter((r) => r.eventType === "rebuild_critique.unit_charged"),
    ).toHaveLength(0);
  });

  it("defense-in-depth: refuses to charge when accumulator is out of range", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);
    // Drop the CHECK so we can poison the column directly. Restored at
    // the end of the test so subsequent runs are clean.
    await db.execute(
      sql`ALTER TABLE users DROP CONSTRAINT users_rebuild_critique_units_range`,
    );
    try {
      await db
        .update(schema.users)
        .set({ rebuildCritiqueUnits: 99 })
        .where(eq(schema.users.id, user.id));

      await expect(chargeOnce(user.id, rebuild.id)).rejects.toThrow(
        /out-of-range/,
      );
    } finally {
      // Reset the poison value so the resetDatabase TRUNCATE in
      // beforeEach can run cleanly even before re-applying the CHECK.
      await db
        .update(schema.users)
        .set({ rebuildCritiqueUnits: 0 })
        .where(eq(schema.users.id, user.id));
      await db.execute(
        sql`ALTER TABLE users ADD CONSTRAINT users_rebuild_critique_units_range CHECK (rebuild_critique_units >= 0 AND rebuild_critique_units < 5)`,
      );
    }
  });
});

describe("previewRebuildCritiqueCost — read-only preflight", () => {
  it("reports wouldChargeCredits=0 when not at the rollover boundary", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
    await setUnits(user.id, 0);

    const preview = await previewRebuildCritiqueCost({ userId: user.id });
    expect(preview).not.toBeNull();
    expect(preview!.wouldChargeCredits).toBe(0);
    expect(preview!.canAffordNext).toBe(true);
    expect(preview!.currentBalance).toBe(5);
    expect(preview!.currentUnits).toBe(0);
  });

  it("reports wouldChargeCredits=1 when at the rollover boundary", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
    await setUnits(user.id, REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1);

    const preview = await previewRebuildCritiqueCost({ userId: user.id });
    expect(preview).not.toBeNull();
    expect(preview!.wouldChargeCredits).toBe(1);
    expect(preview!.canAffordNext).toBe(true);
    expect(preview!.currentBalance).toBe(5);
    expect(preview!.currentUnits).toBe(REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1);
  });

  it("reports canAffordNext=false at the rollover boundary with zero balance", async () => {
    const user = await seedUser();
    await setBalance(user.id, 0);
    await setUnits(user.id, REBUILD_CRITIQUE_UNITS_PER_CREDIT - 1);

    const preview = await previewRebuildCritiqueCost({ userId: user.id });
    expect(preview).not.toBeNull();
    expect(preview!.wouldChargeCredits).toBe(1);
    expect(preview!.canAffordNext).toBe(false);
  });

  it("does not mutate state — repeat reads return the same answer", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
    await setUnits(user.id, 2);

    await previewRebuildCritiqueCost({ userId: user.id });
    await previewRebuildCritiqueCost({ userId: user.id });
    const after = await readUser(user.id);
    expect(after.creditBalance).toBe(5);
    expect(after.rebuildCritiqueUnits).toBe(2);
  });

  it("returns null for a soft-deleted user (consistent with chargeRebuildCritique's filter)", async () => {
    const user = await seedUser();
    await db
      .update(schema.users)
      .set({ deletedAt: new Date() })
      .where(eq(schema.users.id, user.id));

    const preview = await previewRebuildCritiqueCost({ userId: user.id });
    expect(preview).toBeNull();
  });

  it("returns null for an unknown userId (caller maps to 401, not 500)", async () => {
    const preview = await previewRebuildCritiqueCost({
      userId: "00000000-0000-0000-0000-000000000000",
    });
    expect(preview).toBeNull();
  });

  it("input validation: rejects empty userId", async () => {
    await expect(
      previewRebuildCritiqueCost({ userId: "" }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
