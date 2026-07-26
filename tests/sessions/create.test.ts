/**
 * Behavior tests for the session-creation pipeline.
 *
 * We hit three layers:
 *
 *   1. The shared Zod payload schema (`createSessionPayloadSchema`).
 *      Pure unit tests — these are the contract the API and the
 *      server action both enforce.
 *   2. The `createSession` core helper. Exercises the real
 *      transaction against a local Postgres so we know the
 *      `audit_log` row is co-written and `state` lands as `created`.
 *   3. The dashboard list query (`listUserSessions`). Confirms a
 *      freshly-created session shows up in the list and is properly
 *      scoped to the owning user (no cross-tenant leakage).
 *
 * The HTTP route (`POST /api/sessions`) is not exercised here —
 * its behavior is the schema check + `createSession` call + a
 * `NextResponse.json`. The schema and core are covered exhaustively
 * below; the route's auth-gate and JSON shape are covered by the
 * Playwright suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";
import { createSessionPayloadSchema } from "@/lib/sessions/schemas";
import { listUserSessions } from "@/lib/queries/sessions";

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

const VALID_PAYLOAD = {
  companyName: "Stripe",
  roleTitle: "Senior Backend Engineer",
  level: "senior",
  roundType: "system_design",
  scheduledAt: null,
  consentAffirmed: true,
} as const;

describe("createSessionPayloadSchema", () => {
  it("accepts a fully populated payload with consent_affirmed: true", () => {
    const out = createSessionPayloadSchema.safeParse(VALID_PAYLOAD);
    expect(out.success).toBe(true);
  });

  it("rejects when consentAffirmed is missing", () => {
    const { consentAffirmed: _drop, ...rest } = VALID_PAYLOAD;
    void _drop;
    const out = createSessionPayloadSchema.safeParse(rest);
    expect(out.success).toBe(false);
    if (out.success) return;
    const fields = out.error.issues.map((i) => i.path.join("."));
    expect(fields).toContain("consentAffirmed");
  });

  it("rejects consentAffirmed: false (the headline rule)", () => {
    const out = createSessionPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      consentAffirmed: false,
    });
    expect(out.success).toBe(false);
  });

  it("rejects the string 'true' — coercion is intentionally off", () => {
    const out = createSessionPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      consentAffirmed: "true",
    });
    expect(out.success).toBe(false);
  });

  it("rejects an unknown level token", () => {
    const out = createSessionPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      level: "godmode",
    });
    expect(out.success).toBe(false);
  });

  it("rejects an unknown round type", () => {
    const out = createSessionPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      roundType: "pair_programming",
    });
    expect(out.success).toBe(false);
  });

  it("rejects empty company / role strings", () => {
    expect(
      createSessionPayloadSchema.safeParse({
        ...VALID_PAYLOAD,
        companyName: "   ",
      }).success,
    ).toBe(false);
    expect(
      createSessionPayloadSchema.safeParse({
        ...VALID_PAYLOAD,
        roleTitle: "",
      }).success,
    ).toBe(false);
  });

  it("normalizes whitespace inside company/role names", () => {
    const out = createSessionPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      companyName: "  Stripe   Inc  ",
      roleTitle: "Senior\tBackend Engineer",
    });
    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.companyName).toBe("Stripe Inc");
    expect(out.data.roleTitle).toBe("Senior Backend Engineer");
  });

  it("strips NUL bytes (would otherwise break Postgres `text` insert)", () => {
    const out = createSessionPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      companyName: "Stripe\u0000Inc",
    });
    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.companyName).toBe("StripeInc");
    // No literal NUL anywhere in the cleaned output.
    expect(out.data.companyName).not.toContain("\u0000");
  });

  it("strips C0 control characters and DEL", () => {
    const out = createSessionPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      // Bell + escape + DEL bracketing real text.
      companyName: "\u0007Stripe\u001b\u007f",
    });
    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.companyName).toBe("Stripe");
  });

  it("strips bidi overrides and zero-width characters (trojan-source defense)", () => {
    const out = createSessionPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      // RLO + Senior + PDF (right-to-left override sandwich) + ZWSP.
      roleTitle: "\u202ESenior\u202C\u200BEngineer",
    });
    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.roleTitle).toBe("SeniorEngineer");
  });

  it("rejects input that becomes empty after stripping", () => {
    // A string that's *only* control / bidi characters has no
    // visible content. After cleanup we end up at length 0, which
    // the trailing `min(1)` rejects with a clean validation error.
    const out = createSessionPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      companyName: "\u0000\u202E\u200B",
    });
    expect(out.success).toBe(false);
  });

  it("accepts a valid ISO-ish scheduledAt and coerces to a Date", () => {
    const out = createSessionPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      scheduledAt: "2026-06-01T14:00",
    });
    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.scheduledAt).toBeInstanceOf(Date);
  });

  it("accepts an empty scheduledAt as null (form's untouched state)", () => {
    const out = createSessionPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      scheduledAt: "",
    });
    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.scheduledAt ?? null).toBeNull();
  });
});

describe("createSession (DB)", () => {
  it("inserts a row with state=created and a non-null consent timestamp", async () => {
    const user = await seedUser();

    const before = Date.now();
    const row = await createSession({
      userId: user.id,
      companyName: "Stripe",
      roleTitle: "Senior Backend Engineer",
      level: "senior",
      roundType: "system_design",
      scheduledAt: null,
    });
    const after = Date.now();

    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.userId).toBe(user.id);
    expect(row.state).toBe("created");
    expect(row.companyName).toBe("Stripe");
    expect(row.roleTitle).toBe("Senior Backend Engineer");
    expect(row.level).toBe("senior");
    expect(row.roundType).toBe("system_design");
    expect(row.scheduledAt).toBeNull();
    expect(row.consentAffirmedAt).toBeInstanceOf(Date);
    expect(row.consentAffirmedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.consentAffirmedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("writes a session.created audit log entry inside the same transaction", async () => {
    const user = await seedUser();
    const row = await createSession({
      userId: user.id,
      companyName: "Linear",
      roleTitle: "Product Engineer",
      level: "mid",
      roundType: "behavioral",
      scheduledAt: null,
      ipAddress: "203.0.113.7",
      userAgent: "Mozilla/5.0 (test)",
    });

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));
    expect(audits).toHaveLength(1);
    const [entry] = audits;
    expect(entry?.eventType).toBe("session.created");
    expect(entry?.ipAddress).toBe("203.0.113.7");
    expect(entry?.userAgent).toBe("Mozilla/5.0 (test)");
    expect(entry?.eventData).toMatchObject({
      sessionId: row.id,
      companyName: "Linear",
      roleTitle: "Product Engineer",
      level: "mid",
      roundType: "behavioral",
    });
  });

  it("persists scheduledAt when provided", async () => {
    const user = await seedUser();
    const scheduledAt = new Date("2026-06-01T18:00:00.000Z");
    const row = await createSession({
      userId: user.id,
      companyName: "Vercel",
      roleTitle: "Senior Engineer",
      level: "senior",
      roundType: "coding",
      scheduledAt,
    });
    expect(row.scheduledAt?.toISOString()).toBe(scheduledAt.toISOString());
  });
});

describe("dashboard query (post-create visibility)", () => {
  it("listUserSessions returns the freshly-created row", async () => {
    const user = await seedUser();
    await createSession({
      userId: user.id,
      companyName: "Stripe",
      roleTitle: "Backend Engineer",
      level: "senior",
      roundType: "coding",
      scheduledAt: null,
    });

    const list = await listUserSessions(user.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.companyName).toBe("Stripe");
    expect(list[0]?.state).toBe("created");
  });

  it("listUserSessions does not leak another user's sessions (ownership filter)", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");

    await createSession({
      userId: alice.id,
      companyName: "Stripe",
      roleTitle: "Backend Engineer",
      level: "senior",
      roundType: "coding",
      scheduledAt: null,
    });
    await createSession({
      userId: bob.id,
      companyName: "Linear",
      roleTitle: "Product Engineer",
      level: "mid",
      roundType: "behavioral",
      scheduledAt: null,
    });

    const aliceList = await listUserSessions(alice.id);
    const bobList = await listUserSessions(bob.id);

    expect(aliceList).toHaveLength(1);
    expect(aliceList[0]?.companyName).toBe("Stripe");
    expect(bobList).toHaveLength(1);
    expect(bobList[0]?.companyName).toBe("Linear");
  });
});
