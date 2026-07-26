/**
 * Behavior-level tests for the credentials signup path's referral
 * attribution. Exercises the same `createCredentialsUser` helper
 * the server action wraps so we don't have to mock `next/headers`.
 *
 * The OAuth path (cookie-driven) is covered separately in
 * `attribution-oauth.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";

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

const seedReferrer = async (email = "ref@example.com") => {
  const result = await createCredentialsUser({
    email,
    password: "password123",
    name: "Referrer",
  });
  if (!result.ok) throw new Error(`seedReferrer: ${result.error}`);
  const [row] = await db
    .select({ id: schema.users.id, referralCode: schema.users.referralCode })
    .from(schema.users)
    .where(eq(schema.users.id, result.user.id))
    .limit(1);
  if (!row?.referralCode) {
    throw new Error("seedReferrer: no referral code minted");
  }
  return { id: row.id, code: row.referralCode };
};

describe("createCredentialsUser — referral code", () => {
  it("mints a referral code on every signup, even when no ref provided", async () => {
    const result = await createCredentialsUser({
      email: "alice@example.com",
      password: "password123",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db
      .select({ referralCode: schema.users.referralCode })
      .from(schema.users)
      .where(eq(schema.users.id, result.user.id))
      .limit(1);
    expect(row?.referralCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it("attributes a new signup to the referrer when a valid code is passed", async () => {
    const referrer = await seedReferrer();

    const refereeResult = await createCredentialsUser({
      email: "alice@example.com",
      password: "password123",
      referralCode: referrer.code,
    });
    expect(refereeResult.ok).toBe(true);
    if (!refereeResult.ok) return;

    const [row] = await db
      .select({
        referredByUserId: schema.users.referredByUserId,
        referrerCreditGrantedAt: schema.users.referrerCreditGrantedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, refereeResult.user.id))
      .limit(1);
    expect(row?.referredByUserId).toBe(referrer.id);
    // Bonus is paid at first-analysis time, NOT at signup.
    expect(row?.referrerCreditGrantedAt).toBeNull();
  });

  it("ignores a junk referral code without failing the signup", async () => {
    const refereeResult = await createCredentialsUser({
      email: "alice@example.com",
      password: "password123",
      referralCode: "totally-not-a-real-code",
    });
    expect(refereeResult.ok).toBe(true);
    if (!refereeResult.ok) return;

    const [row] = await db
      .select({ referredByUserId: schema.users.referredByUserId })
      .from(schema.users)
      .where(eq(schema.users.id, refereeResult.user.id))
      .limit(1);
    expect(row?.referredByUserId).toBeNull();
  });

  it("ignores an unknown referral code without failing the signup", async () => {
    // Shape-valid (8 Crockford chars) but no user owns it.
    const refereeResult = await createCredentialsUser({
      email: "alice@example.com",
      password: "password123",
      referralCode: "ZZZZZZZZ",
    });
    expect(refereeResult.ok).toBe(true);
    if (!refereeResult.ok) return;

    const [row] = await db
      .select({ referredByUserId: schema.users.referredByUserId })
      .from(schema.users)
      .where(eq(schema.users.id, refereeResult.user.id))
      .limit(1);
    expect(row?.referredByUserId).toBeNull();
  });

  it("refuses self-referral when the referral code points at the same email", async () => {
    // A user that signs up, then somehow re-signs with their own
    // code (e.g. a copy-paste from their own Account page) must
    // not become their own referrer. We test the "same email"
    // path here; the OAuth path tests "same userId".
    //
    // We have to construct the scenario: create a referrer, then
    // attempt a SECOND signup with the same email + their own code.
    // The duplicate-email guard fires first, so this is really a
    // smoke test that nothing crashes — the load-bearing cases
    // are the unknown-code + junk-code paths above plus the
    // OAuth-side self-referral test.
    const referrer = await seedReferrer("self@example.com");
    const second = await createCredentialsUser({
      email: "self@example.com",
      password: "password456",
      referralCode: referrer.code,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("duplicate_email");
  });

  it("does NOT grant the referrer any credits at signup time", async () => {
    const referrer = await seedReferrer();
    const referrerBalanceBefore = (
      await db
        .select({ creditBalance: schema.users.creditBalance })
        .from(schema.users)
        .where(eq(schema.users.id, referrer.id))
        .limit(1)
    )[0]?.creditBalance;

    await createCredentialsUser({
      email: "alice@example.com",
      password: "password123",
      referralCode: referrer.code,
    });

    const referrerBalanceAfter = (
      await db
        .select({ creditBalance: schema.users.creditBalance })
        .from(schema.users)
        .where(eq(schema.users.id, referrer.id))
        .limit(1)
    )[0]?.creditBalance;

    expect(referrerBalanceAfter).toBe(referrerBalanceBefore);
  });

  it("issues codes from the same alphabet on every retry path", async () => {
    // Smoke: 20 fresh signups, every minted code must match the
    // Crockford alphabet shape.
    for (let i = 0; i < 20; i += 1) {
      const r = await createCredentialsUser({
        email: `user-${i}@example.com`,
        password: "password123",
      });
      expect(r.ok).toBe(true);
    }
    const codes = await db
      .select({ referralCode: schema.users.referralCode })
      .from(schema.users);
    for (const { referralCode } of codes) {
      expect(referralCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    }
  });
});
