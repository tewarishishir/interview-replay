/**
 * Behavior-level tests for the credentials signup / signin flow.
 *
 * We exercise the testable core (`createCredentialsUser`,
 * `verifyCredentials`) directly instead of the server actions —
 * server actions depend on `next/headers` and the Auth.js v5
 * `signIn()` redirect machinery, which Vitest can't reasonably host.
 * The actions are thin wrappers around these helpers, so the
 * behaviors covered here ARE the action behaviors minus rate
 * limiting (separate test).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import {
  createCredentialsUser,
  verifyCredentials,
} from "@/lib/auth/users";
import { SIGNUP_BONUS_CREDITS } from "@/lib/auth/constants";
import { signUpFormSchema } from "@/lib/auth/schemas";

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

describe("signup", () => {
  it("creates a user with the signup bonus credits and a matching ledger row", async () => {
    const result = await createCredentialsUser({
      email: "alice@example.com",
      password: "supersecret1",
      name: "Alice Example",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.creditBalance).toBe(SIGNUP_BONUS_CREDITS);
    expect(result.user.email).toBe("alice@example.com");
    expect(result.user.name).toBe("Alice Example");

    const [row] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, result.user.id))
      .limit(1);
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.creditBalance).toBe(SIGNUP_BONUS_CREDITS);

    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.userId, result.user.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.delta).toBe(SIGNUP_BONUS_CREDITS);
    expect(ledger[0]?.balanceAfter).toBe(SIGNUP_BONUS_CREDITS);
    expect(ledger[0]?.reason).toBe("signup_bonus");
  });

  it("normalizes the email to lowercase + trim", async () => {
    const result = await createCredentialsUser({
      email: "  Alice@Example.COM ",
      password: "supersecret1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.email).toBe("alice@example.com");
  });

  it("returns duplicate_email when the email is already taken", async () => {
    const first = await createCredentialsUser({
      email: "dup@example.com",
      password: "supersecret1",
    });
    expect(first.ok).toBe(true);

    const second = await createCredentialsUser({
      email: "dup@example.com",
      password: "anotherpass1",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("duplicate_email");

    // Only one row should have been created end-to-end.
    const allUsers = await db.select().from(schema.users);
    expect(allUsers).toHaveLength(1);
  });

  it("issues exactly one verification token row per signup", async () => {
    const result = await createCredentialsUser({
      email: "verify@example.com",
      password: "supersecret1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verifyUrl).toMatch(/\/api\/auth\/verify-email\?token=/);

    const tokens = await db.select().from(schema.verificationTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.identifier).toBe("verify@example.com");
  });

  it("treats whitespace-only names as null", async () => {
    const result = await createCredentialsUser({
      email: "noname@example.com",
      password: "supersecret1",
      name: "   ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.name).toBeNull();
  });
});

describe("signup form schema (acceptance criteria)", () => {
  it("rejects an empty password", () => {
    const out = signUpFormSchema.safeParse({
      email: "ok@example.com",
      password: "",
    });
    expect(out.success).toBe(false);
  });

  it("rejects a password under 8 chars", () => {
    const out = signUpFormSchema.safeParse({
      email: "ok@example.com",
      password: "abc1",
    });
    expect(out.success).toBe(false);
  });

  it("rejects a password with no digit", () => {
    const out = signUpFormSchema.safeParse({
      email: "ok@example.com",
      password: "alphabetical",
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      const messages = out.error.issues.map((i) => i.message);
      expect(messages.some((m) => /number|digit/i.test(m))).toBe(true);
    }
  });

  it("rejects an invalid email", () => {
    const out = signUpFormSchema.safeParse({
      email: "not-an-email",
      password: "validpass1",
    });
    expect(out.success).toBe(false);
  });

  it("accepts a valid email + 8+ chars + a digit", () => {
    const out = signUpFormSchema.safeParse({
      email: "ok@example.com",
      password: "validpass1",
    });
    expect(out.success).toBe(true);
  });
});

describe("signin (verifyCredentials)", () => {
  beforeEach(async () => {
    await createCredentialsUser({
      email: "bob@example.com",
      password: "rightpass1",
      name: "Bob",
    });
  });

  it("returns the user on the correct password", async () => {
    const result = await verifyCredentials({
      email: "bob@example.com",
      password: "rightpass1",
    });
    expect(result).not.toBeNull();
    expect(result?.email).toBe("bob@example.com");
    expect(result?.name).toBe("Bob");
    // Never leak the password hash through the credentials return.
    expect(result as unknown as Record<string, unknown>).not.toHaveProperty(
      "passwordHash",
    );
  });

  it("returns null on the wrong password", async () => {
    const result = await verifyCredentials({
      email: "bob@example.com",
      password: "wrongpass1",
    });
    expect(result).toBeNull();
  });

  it("returns null for an unknown email", async () => {
    const result = await verifyCredentials({
      email: "nope@example.com",
      password: "rightpass1",
    });
    expect(result).toBeNull();
  });

  it("normalizes email casing on lookup", async () => {
    const result = await verifyCredentials({
      email: "BOB@example.com",
      password: "rightpass1",
    });
    expect(result?.email).toBe("bob@example.com");
  });

  it("constant-ish-time on missing user vs bad password", async () => {
    // Both should incur an argon2 verify of comparable cost. We assert
    // the runtimes are within a factor of 4 — a generous bound that
    // would still fail loudly if someone reverted the dummy-hash path.
    const t0 = performance.now();
    await verifyCredentials({
      email: "no-such-user@example.com",
      password: "irrelevant",
    });
    const dMissing = performance.now() - t0;

    const t1 = performance.now();
    await verifyCredentials({
      email: "bob@example.com",
      password: "wrongpass1",
    });
    const dWrong = performance.now() - t1;

    const ratio = Math.max(dMissing, dWrong) / Math.max(1, Math.min(dMissing, dWrong));
    expect(ratio).toBeLessThan(4);
  });
});
