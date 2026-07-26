/**
 * Tests for the outcome-reminder eligibility query +
 * audit-log dedupe primitive.
 *
 * The job runner function itself (`promptForOutcome`) is a thin
 * orchestrator over `findOutcomeReminderCandidates` +
 * `sendOutcomeReminderEmail` + `recordOutcomeReminderSent`.
 * Testing the helpers covers the load-bearing logic; the
 * orchestration loop is exercised by the existing job-runner tests
 * pattern (we don't spin up an job runner dev server in unit tests).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";
import {
  createOutcome,
  findOutcomeReminderCandidates,
  recordOutcomeReminderSent,
} from "@/lib/sessions/outcomes";

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

const seedUser = async (
  email: string,
  opts?: { verified?: boolean; deleted?: boolean },
) => {
  const r = await createCredentialsUser({
    email,
    password: "password123",
    name: email,
  });
  if (!r.ok) throw new Error(`seedUser failed: ${r.error}`);
  if (opts?.verified !== false) {
    await db
      .update(schema.users)
      .set({ emailVerified: new Date("2026-04-01T00:00:00Z") })
      .where(eq(schema.users.id, r.user.id));
  }
  if (opts?.deleted) {
    await db
      .update(schema.users)
      .set({ deletedAt: new Date("2026-04-15T00:00:00Z") })
      .where(eq(schema.users.id, r.user.id));
  }
  return r.user;
};

/**
 * Plant a `complete` session whose `created_at` is older than
 * `daysAgo`. We can't pass createdAt to `createSession` (the
 * helper stamps now()), so we backdate after the fact.
 */
const seedAgedCompleteSession = async (args: {
  userId: string;
  company?: string;
  daysAgo: number;
}) => {
  const row = await createSession({
    userId: args.userId,
    companyName: args.company ?? "Stripe",
    roleTitle: "Senior Backend Engineer",
    level: "senior",
    roundType: "system_design",
    scheduledAt: null,
  });
  const backdated = new Date(
    Date.now() - args.daysAgo * 24 * 60 * 60 * 1000,
  );
  await db
    .update(schema.interviewSessions)
    .set({
      state: "complete",
      createdAt: backdated,
      updatedAt: backdated,
    })
    .where(eq(schema.interviewSessions.id, row.id));
  return row;
};

describe("findOutcomeReminderCandidates", () => {
  it("returns sessions older than 14 days with no outcome", async () => {
    const alice = await seedUser("alice@example.com");
    const session = await seedAgedCompleteSession({
      userId: alice.id,
      daysAgo: 15,
    });

    const candidates = await findOutcomeReminderCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sessionId).toBe(session.id);
    expect(candidates[0]!.email).toBe("alice@example.com");
  });

  it("excludes sessions younger than the age cutoff", async () => {
    const alice = await seedUser("alice@example.com");
    await seedAgedCompleteSession({ userId: alice.id, daysAgo: 5 });

    const candidates = await findOutcomeReminderCandidates();
    expect(candidates).toHaveLength(0);
  });

  it("excludes sessions that already have an outcome", async () => {
    const alice = await seedUser("alice@example.com");
    const session = await seedAgedCompleteSession({
      userId: alice.id,
      daysAgo: 20,
    });
    await createOutcome({
      sessionId: session.id,
      body: { outcome_type: "received_offer" },
      audit: { userId: alice.id },
    });

    const candidates = await findOutcomeReminderCandidates();
    expect(candidates).toHaveLength(0);
  });

  it("excludes sessions where we've already sent the reminder (audit dedupe)", async () => {
    const alice = await seedUser("alice@example.com");
    const session = await seedAgedCompleteSession({
      userId: alice.id,
      daysAgo: 20,
    });

    const before = await findOutcomeReminderCandidates();
    expect(before).toHaveLength(1);

    await recordOutcomeReminderSent({
      sessionId: session.id,
      userId: alice.id,
      email: alice.email,
      dispatched: true,
    });

    const after = await findOutcomeReminderCandidates();
    expect(after).toHaveLength(0);
  });

  it("excludes unverified users", async () => {
    const alice = await seedUser("alice@example.com", { verified: false });
    await seedAgedCompleteSession({ userId: alice.id, daysAgo: 20 });

    const candidates = await findOutcomeReminderCandidates();
    expect(candidates).toHaveLength(0);
  });

  it("excludes users who are pending deletion", async () => {
    const alice = await seedUser("alice@example.com", { deleted: true });
    await seedAgedCompleteSession({ userId: alice.id, daysAgo: 20 });

    const candidates = await findOutcomeReminderCandidates();
    expect(candidates).toHaveLength(0);
  });

  it("excludes soft-deleted sessions", async () => {
    const alice = await seedUser("alice@example.com");
    const session = await seedAgedCompleteSession({
      userId: alice.id,
      daysAgo: 30,
    });
    await db
      .update(schema.interviewSessions)
      .set({ state: "deleted", deletedAt: new Date() })
      .where(eq(schema.interviewSessions.id, session.id));

    const candidates = await findOutcomeReminderCandidates();
    expect(candidates).toHaveLength(0);
  });

  it("returns multiple candidates across users + sessions", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    await seedAgedCompleteSession({
      userId: alice.id,
      company: "Stripe",
      daysAgo: 20,
    });
    await seedAgedCompleteSession({
      userId: alice.id,
      company: "Datadog",
      daysAgo: 16,
    });
    await seedAgedCompleteSession({
      userId: bob.id,
      company: "LLM provider",
      daysAgo: 22,
    });

    const candidates = await findOutcomeReminderCandidates();
    expect(candidates).toHaveLength(3);

    const companies = candidates.map((c) => c.companyName).sort();
    expect(companies).toEqual(["LLM provider", "Datadog", "Stripe"]);
  });
});

describe("recordOutcomeReminderSent", () => {
  it("writes an audit row with sessionId in the JSON payload", async () => {
    const alice = await seedUser("alice@example.com");
    const session = await seedAgedCompleteSession({
      userId: alice.id,
      daysAgo: 20,
    });

    await recordOutcomeReminderSent({
      sessionId: session.id,
      userId: alice.id,
      email: alice.email,
      dispatched: true,
      resendMessageId: "resend-abc",
    });

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.eventType, "outcome.reminder_sent"));
    expect(rows).toHaveLength(1);
    const data = rows[0]!.eventData as Record<string, unknown>;
    expect(data.sessionId).toBe(session.id);
    expect(data.email).toBe(alice.email);
    expect(data.dispatched).toBe(true);
    expect(data.resendMessageId).toBe("resend-abc");
  });

  it("dedupe query (raw SQL) finds the reminded session", async () => {
    const alice = await seedUser("alice@example.com");
    const session = await seedAgedCompleteSession({
      userId: alice.id,
      daysAgo: 20,
    });
    await recordOutcomeReminderSent({
      sessionId: session.id,
      userId: alice.id,
      email: alice.email,
      dispatched: false, // even an undelivered reminder dedupes
    });

    const result = await db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM ${schema.auditLog}
          WHERE ${schema.auditLog.eventType} = 'outcome.reminder_sent'
            AND ${schema.auditLog.eventData}->>'sessionId' = ${session.id}::text`,
    );
    expect(result.rows[0]!.count).toBe(1);
  });
});
