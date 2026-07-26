/**
 * Integration tests for `recordAnalysisFailure` — the worker's
 * compensating helper that runs when analysis fails terminally
 * (LLM timeout, invalid JSON, etc.).
 *
 * Headline contract under test: the free re-analysis path
 * (creditsToRefund === 0) must STILL write a delta=0
 * `interview_refund` ledger row. That row is the audit signal
 * `hasConsumedFreeReanalysis` reads to decide "did the user
 * actually receive the value of their free re-run?"; without
 * it, a transient worker failure would permanently burn the
 * user's one-shot free re-run.
 *
 * Also covers the broader behaviors:
 *   - Idempotent on a session already in `failed` (no-op).
 *   - Refund applied + balance bumped + ledger row written for
 *     the paid path.
 *   - Free path leaves balance untouched but flips state +
 *     writes the audit row + the delta=0 refund row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";
import { recordAnalysisFailure } from "@/lib/sessions/analyze";
import { hasConsumedFreeReanalysis } from "@/lib/credits";

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

const setBalance = async (userId: string, balance: number) => {
  await db
    .update(schema.users)
    .set({ creditBalance: balance })
    .where(eq(schema.users.id, userId));
};

const seedAnalyzingSession = async (userId: string) => {
  const row = await createSession({
    userId,
    companyName: "Stripe",
    roleTitle: "Backend Engineer",
    level: "senior",
    roundType: "coding",
    scheduledAt: null,
  });
  await db
    .update(schema.interviewSessions)
    .set({ state: "analyzing" })
    .where(eq(schema.interviewSessions.id, row.id));
  return row;
};

describe("recordAnalysisFailure — paid re-run", () => {
  it("flips state to failed, refunds credits, writes refund + audit rows", async () => {
    const user = await seedUser();
    await setBalance(user.id, 3);
    const session = await seedAnalyzingSession(user.id);

    await recordAnalysisFailure({
      sessionId: session.id,
      userId: user.id,
      errorMessage: "llm_timeout",
      creditsToRefund: 2,
    });

    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("failed");

    const [u] = await db
      .select({ creditBalance: schema.users.creditBalance })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(u?.creditBalance).toBe(5);

    const refunds = await db
      .select()
      .from(schema.creditTransactions)
      .where(
        and(
          eq(schema.creditTransactions.relatedSessionId, session.id),
          eq(schema.creditTransactions.reason, "interview_refund"),
        ),
      );
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.delta).toBe(2);
  });

  it("is a no-op when the session is already in `failed` (idempotency)", async () => {
    const user = await seedUser();
    await setBalance(user.id, 5);
    const session = await seedAnalyzingSession(user.id);

    await recordAnalysisFailure({
      sessionId: session.id,
      userId: user.id,
      errorMessage: "first_call",
      creditsToRefund: 2,
    });

    // Second call: state is already `failed`, the CAS misses, no
    // additional refund row, balance untouched beyond the first run.
    await recordAnalysisFailure({
      sessionId: session.id,
      userId: user.id,
      errorMessage: "second_call",
      creditsToRefund: 2,
    });

    const refunds = await db
      .select()
      .from(schema.creditTransactions)
      .where(
        and(
          eq(schema.creditTransactions.relatedSessionId, session.id),
          eq(schema.creditTransactions.reason, "interview_refund"),
        ),
      );
    expect(refunds).toHaveLength(1);

    const [u] = await db
      .select({ creditBalance: schema.users.creditBalance })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(u?.creditBalance).toBe(7);
  });
});

describe("recordAnalysisFailure — free re-run", () => {
  it("writes a delta=0 refund row so the user keeps their free slot", async () => {
    const user = await seedUser();
    await setBalance(user.id, 0);
    const session = await seedAnalyzingSession(user.id);

    // Pretend the consume already wrote the delta=0 charge — this
    // matches the exact state the worker sees on failure.
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 0,
      balanceAfter: 0,
      reason: "interview_charge",
      relatedSessionId: session.id,
    });

    await recordAnalysisFailure({
      sessionId: session.id,
      userId: user.id,
      errorMessage: "llm_timeout",
      creditsToRefund: 0,
    });

    const refunds = await db
      .select()
      .from(schema.creditTransactions)
      .where(
        and(
          eq(schema.creditTransactions.relatedSessionId, session.id),
          eq(schema.creditTransactions.reason, "interview_refund"),
        ),
      );
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.delta).toBe(0);
    expect(refunds[0]?.userId).toBe(user.id);

    const [u] = await db
      .select({ creditBalance: schema.users.creditBalance })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(u?.creditBalance).toBe(0);

    // The headline assertion: the helper sees net=0 and reports
    // the free slot is available again.
    const stillUsed = await hasConsumedFreeReanalysis({
      sessionId: session.id,
      userId: user.id,
    });
    expect(stillUsed).toBe(false);
  });

  it("free-path is also idempotent (no double refund row on second call)", async () => {
    const user = await seedUser();
    await setBalance(user.id, 0);
    const session = await seedAnalyzingSession(user.id);

    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 0,
      balanceAfter: 0,
      reason: "interview_charge",
      relatedSessionId: session.id,
    });

    await recordAnalysisFailure({
      sessionId: session.id,
      userId: user.id,
      errorMessage: "first_call",
      creditsToRefund: 0,
    });
    await recordAnalysisFailure({
      sessionId: session.id,
      userId: user.id,
      errorMessage: "second_call",
      creditsToRefund: 0,
    });

    const refunds = await db
      .select()
      .from(schema.creditTransactions)
      .where(
        and(
          eq(schema.creditTransactions.relatedSessionId, session.id),
          eq(schema.creditTransactions.reason, "interview_refund"),
        ),
      );
    expect(refunds).toHaveLength(1);
  });
});

describe("hasConsumedFreeReanalysis — query helper", () => {
  it("returns false when no ledger rows exist for the session", async () => {
    const user = await seedUser();
    const session = await createSession({
      userId: user.id,
      companyName: "Stripe",
      roleTitle: "Backend Engineer",
      level: "senior",
      roundType: "coding",
      scheduledAt: null,
    });
    expect(
      await hasConsumedFreeReanalysis({
        sessionId: session.id,
        userId: user.id,
      }),
    ).toBe(false);
  });

  it("returns true when the session has an unmatched delta=0 charge", async () => {
    const user = await seedUser();
    const session = await createSession({
      userId: user.id,
      companyName: "Stripe",
      roleTitle: "Backend Engineer",
      level: "senior",
      roundType: "coding",
      scheduledAt: null,
    });
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 0,
      balanceAfter: 0,
      reason: "interview_charge",
      relatedSessionId: session.id,
    });
    expect(
      await hasConsumedFreeReanalysis({
        sessionId: session.id,
        userId: user.id,
      }),
    ).toBe(true);
  });

  it("returns false when a delta=0 refund cancels the delta=0 charge (net=0)", async () => {
    const user = await seedUser();
    const session = await createSession({
      userId: user.id,
      companyName: "Stripe",
      roleTitle: "Backend Engineer",
      level: "senior",
      roundType: "coding",
      scheduledAt: null,
    });
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 0,
      balanceAfter: 0,
      reason: "interview_charge",
      relatedSessionId: session.id,
    });
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 0,
      balanceAfter: 0,
      reason: "interview_refund",
      relatedSessionId: session.id,
    });
    expect(
      await hasConsumedFreeReanalysis({
        sessionId: session.id,
        userId: user.id,
      }),
    ).toBe(false);
  });

  it("ignores PAID charges (delta < 0) and PAID refunds (delta > 0)", async () => {
    // Only delta=0 rows count toward the free invariant.
    const user = await seedUser();
    const session = await createSession({
      userId: user.id,
      companyName: "Stripe",
      roleTitle: "Backend Engineer",
      level: "senior",
      roundType: "coding",
      scheduledAt: null,
    });
    await db.insert(schema.creditTransactions).values([
      {
        userId: user.id,
        delta: -2,
        balanceAfter: 0,
        reason: "interview_charge",
        relatedSessionId: session.id,
      },
      {
        userId: user.id,
        delta: 2,
        balanceAfter: 2,
        reason: "interview_refund",
        relatedSessionId: session.id,
      },
    ]);
    expect(
      await hasConsumedFreeReanalysis({
        sessionId: session.id,
        userId: user.id,
      }),
    ).toBe(false);
  });

  it("ignores ledger rows owned by a different user (defense-in-depth tenancy isolation)", async () => {
    // A delta=0 charge stamped with another user must not leak
    // through the helper, even if the related_session_id matches.
    // Current callers verify ownership upstream, but this pins
    // the explicit scope baked into the WHERE.
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    const sessionAlice = await createSession({
      userId: alice.id,
      companyName: "Stripe",
      roleTitle: "Backend Engineer",
      level: "senior",
      roundType: "coding",
      scheduledAt: null,
    });
    await db.insert(schema.creditTransactions).values({
      userId: alice.id,
      delta: 0,
      balanceAfter: 0,
      reason: "interview_charge",
      relatedSessionId: sessionAlice.id,
    });

    expect(
      await hasConsumedFreeReanalysis({
        sessionId: sessionAlice.id,
        userId: bob.id,
      }),
    ).toBe(false);
  });
});
