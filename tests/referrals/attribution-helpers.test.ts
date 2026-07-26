/**
 * Direct tests for the lower-level referral attribution helpers
 * that the OAuth path uses (`resolveReferrerByCode`,
 * `setReferredByOnTx`). The OAuth `events.createUser` hook is
 * driven by the Auth.js adapter and can't be exercised in
 * isolation without mocking the adapter; these tests cover the
 * exact behaviors that hook composes — which is sufficient to
 * catch any regression in the attribution rules.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import {
  resolveReferrerByCode,
  setReferredByOnTx,
} from "@/lib/referrals/attribution";

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

const seedUser = async (email: string) => {
  const result = await createCredentialsUser({
    email,
    password: "password123",
    name: email,
  });
  if (!result.ok) throw new Error(`seedUser: ${result.error}`);
  const [row] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      referralCode: schema.users.referralCode,
    })
    .from(schema.users)
    .where(eq(schema.users.id, result.user.id))
    .limit(1);
  if (!row) throw new Error("seedUser: lookup failed");
  if (!row.referralCode) throw new Error("seedUser: code not minted");
  return { id: row.id, email: row.email, code: row.referralCode };
};

describe("resolveReferrerByCode", () => {
  it("returns the referrer for a valid code", async () => {
    const referrer = await seedUser("ref@example.com");
    const out = await resolveReferrerByCode({ code: referrer.code });
    expect(out?.id).toBe(referrer.id);
  });

  it("accepts the code in any case (case-insensitive)", async () => {
    const referrer = await seedUser("ref@example.com");
    const out = await resolveReferrerByCode({
      code: referrer.code.toLowerCase(),
    });
    expect(out?.id).toBe(referrer.id);
  });

  it("returns null for unknown / junk / null codes", async () => {
    expect(await resolveReferrerByCode({ code: null })).toBeNull();
    expect(await resolveReferrerByCode({ code: "" })).toBeNull();
    expect(await resolveReferrerByCode({ code: "ZZZZZZZZ" })).toBeNull();
    expect(
      await resolveReferrerByCode({ code: "totally-bogus" }),
    ).toBeNull();
  });

  it("refuses self-referral by user id", async () => {
    const referrer = await seedUser("ref@example.com");
    const out = await resolveReferrerByCode({
      code: referrer.code,
      excludeUserId: referrer.id,
    });
    expect(out).toBeNull();
  });

  it("refuses self-referral by email (case-insensitive)", async () => {
    const referrer = await seedUser("ref@example.com");
    const out = await resolveReferrerByCode({
      code: referrer.code,
      excludeEmail: "REF@Example.COM",
    });
    expect(out).toBeNull();
  });

  it("returns null when the referrer is soft-deleted", async () => {
    const referrer = await seedUser("ref@example.com");
    await db
      .update(schema.users)
      .set({ deletedAt: new Date() })
      .where(eq(schema.users.id, referrer.id));

    const out = await resolveReferrerByCode({ code: referrer.code });
    expect(out).toBeNull();
  });
});

describe("setReferredByOnTx", () => {
  it("links the referee to the referrer when previously null", async () => {
    const referrer = await seedUser("ref@example.com");
    const referee = await seedUser("alice@example.com");

    await db.transaction(async (tx) => {
      await setReferredByOnTx(tx, referee.id, referrer.id);
    });

    const [row] = await db
      .select({ referredByUserId: schema.users.referredByUserId })
      .from(schema.users)
      .where(eq(schema.users.id, referee.id))
      .limit(1);
    expect(row?.referredByUserId).toBe(referrer.id);
  });

  it("is idempotent — the second call to the same referrer is a no-op", async () => {
    const referrer = await seedUser("ref@example.com");
    const referee = await seedUser("alice@example.com");

    await db.transaction(async (tx) => {
      await setReferredByOnTx(tx, referee.id, referrer.id);
      await setReferredByOnTx(tx, referee.id, referrer.id);
    });

    const [row] = await db
      .select({ referredByUserId: schema.users.referredByUserId })
      .from(schema.users)
      .where(eq(schema.users.id, referee.id))
      .limit(1);
    expect(row?.referredByUserId).toBe(referrer.id);
  });

  it("first writer wins — a different referrer cannot overwrite an existing link", async () => {
    const referrerA = await seedUser("a@example.com");
    const referrerB = await seedUser("b@example.com");
    const referee = await seedUser("alice@example.com");

    await db.transaction(async (tx) => {
      await setReferredByOnTx(tx, referee.id, referrerA.id);
    });
    await db.transaction(async (tx) => {
      await setReferredByOnTx(tx, referee.id, referrerB.id);
    });

    const [row] = await db
      .select({ referredByUserId: schema.users.referredByUserId })
      .from(schema.users)
      .where(eq(schema.users.id, referee.id))
      .limit(1);
    expect(row?.referredByUserId).toBe(referrerA.id);
  });

  it("DB-level CHECK constraint refuses self-referral as a backstop", async () => {
    const referrer = await seedUser("self@example.com");
    // The application code never asks for self-referral, but the
    // CHECK is the load-bearing guarantee. Force the issue with a
    // raw UPDATE.
    await expect(
      db
        .update(schema.users)
        .set({ referredByUserId: referrer.id })
        .where(eq(schema.users.id, referrer.id)),
    ).rejects.toThrow();
  });
});
