/**
 * Verifies the credits-history join surfaces the referee on
 * `referral_bonus` rows so the page can render
 * "Referral from <name>".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { listCreditTransactions } from "@/lib/credits";

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

const seedUser = async (email: string, name?: string) => {
  const r = await createCredentialsUser({
    email,
    password: "password123",
    name: name ?? null,
  });
  if (!r.ok) throw new Error(`seedUser: ${r.error}`);
  return r.user;
};

describe("listCreditTransactions — referral_bonus rows", () => {
  it("joins the referee user and exposes the display name", async () => {
    const referrer = await seedUser("ref@example.com", "Referrer");
    const referee = await seedUser("alice@example.com", "Alice");

    await db.insert(schema.creditTransactions).values({
      userId: referrer.id,
      delta: 1,
      balanceAfter: 11,
      reason: "referral_bonus",
      relatedRefereeUserId: referee.id,
    });

    const items = await listCreditTransactions({ userId: referrer.id });
    const bonus = items.find((i) => i.reason === "referral_bonus");
    expect(bonus).toBeDefined();
    expect(bonus?.relatedReferee).toEqual({
      id: referee.id,
      label: "Alice",
    });
  });

  it("falls back to the referee's email when their display name is null", async () => {
    const referrer = await seedUser("ref@example.com", "Referrer");
    const referee = await seedUser("alice@example.com");

    await db.insert(schema.creditTransactions).values({
      userId: referrer.id,
      delta: 1,
      balanceAfter: 11,
      reason: "referral_bonus",
      relatedRefereeUserId: referee.id,
    });

    const items = await listCreditTransactions({ userId: referrer.id });
    const bonus = items.find((i) => i.reason === "referral_bonus");
    expect(bonus?.relatedReferee?.label).toBe("alice@example.com");
  });

  it("nulls the join when the referee has been hard-deleted", async () => {
    const referrer = await seedUser("ref@example.com", "Referrer");
    const referee = await seedUser("alice@example.com", "Alice");

    await db.insert(schema.creditTransactions).values({
      userId: referrer.id,
      delta: 1,
      balanceAfter: 11,
      reason: "referral_bonus",
      relatedRefereeUserId: referee.id,
    });

    // Hard-delete the referee. The `users` FK on
    // `credit_transactions.user_id` is ON DELETE RESTRICT (we
    // never lose financial attribution) so the test mimics the
    // hard-delete cron's behavior: anonymize their owning ledger
    // rows first, then drop the user. The
    // `credit_transactions.related_referee_user_id` FK is ON
    // DELETE SET NULL — that's the column under test here.
    await db
      .update(schema.creditTransactions)
      .set({ userId: null })
      .where(eq(schema.creditTransactions.userId, referee.id));
    await db.delete(schema.users).where(eq(schema.users.id, referee.id));

    const items = await listCreditTransactions({ userId: referrer.id });
    const bonus = items.find((i) => i.reason === "referral_bonus");
    expect(bonus).toBeDefined();
    // FK is ON DELETE SET NULL — financial truth survives, the
    // attribution link is gone.
    expect(bonus?.relatedReferee).toBeNull();
  });
});
