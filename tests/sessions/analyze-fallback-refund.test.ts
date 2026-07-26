/**
 * Integration tests for `recordFallbackRefund` — the worker's
 * compensating helper that runs when the analyze pipeline writes
 * a fallback report (thin transcript, LLM validation failure,
 * etc.) instead of a real LLM-generated one.
 *
 * The user paid 1 credit for an analysis, got a degraded report,
 * and is entitled to a refund AND to keep their session in
 * `complete` state. This is the load-bearing distinction from
 * `recordAnalysisFailure` (which flips the row to `failed`).
 *
 * Coverage:
 *   - Paid path: refunds credits, writes ledger row, writes audit
 *     row, does NOT touch session state.
 *   - Free re-analysis path: writes a delta=0 refund row so
 *     `hasConsumedFreeReanalysis` sees the cancellation and
 *     restores the user's one-shot slot.
 *   - Audit event type is `session.report.fallback` (NOT
 *     `session.analysis.failed`) so ops dashboards can split
 *     "thin transcript day" from "actual outage day".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";
import { recordFallbackRefund } from "@/lib/sessions/analyze";
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

const seedCompleteSession = async (userId: string) => {
  // Mirrors the production state after `persistReportAndComplete`
  // has already advanced the row — `recordFallbackRefund` is
  // designed to run AFTER persistence.
  const row = await createSession({
    userId,
    companyName: "Apple",
    roleTitle: "SQL Data Analyst",
    level: "mid",
    roundType: "coding",
    scheduledAt: null,
  });
  await db
    .update(schema.interviewSessions)
    .set({ state: "complete" })
    .where(eq(schema.interviewSessions.id, row.id));
  return row;
};

describe("recordFallbackRefund — paid analysis", () => {
  it("refunds credits, writes ledger row, leaves session in `complete`", async () => {
    const user = await seedUser();
    await setBalance(user.id, 3);
    const session = await seedCompleteSession(user.id);

    await recordFallbackRefund({
      sessionId: session.id,
      userId: user.id,
      creditsToRefund: 1,
      fallbackReason: "thin_transcript",
    });

    // Session state untouched — this helper does NOT advance the
    // row, unlike `recordAnalysisFailure`.
    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("complete");

    // Credit balance bumped.
    const [u] = await db
      .select({ creditBalance: schema.users.creditBalance })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(u?.creditBalance).toBe(4);

    // Ledger row written with the right reason + delta.
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
    expect(refunds[0]?.delta).toBe(1);
    expect(refunds[0]?.balanceAfter).toBe(4);
  });

  it("writes a `session.report.fallback` audit row (NOT `session.analysis.failed`)", async () => {
    // The split lets ops dashboards distinguish "we built a
    // degraded report on purpose" from "the pipeline blew up and
    // we recorded a true failure". Same eventData shape though
    // (sessionId + extra context) so consumers stay simple.
    const user = await seedUser();
    await setBalance(user.id, 1);
    const session = await seedCompleteSession(user.id);

    await recordFallbackRefund({
      sessionId: session.id,
      userId: user.id,
      creditsToRefund: 1,
      fallbackReason: "thin_transcript",
    });

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));
    const fallbackRows = audits.filter(
      (r) => r.eventType === "session.report.fallback",
    );
    expect(fallbackRows).toHaveLength(1);
    expect(fallbackRows[0]?.eventData).toMatchObject({
      sessionId: session.id,
      reason: "thin_transcript",
      creditsRefunded: 1,
    });

    // Make sure we did NOT accidentally write a failed audit row
    // alongside the fallback one — those should be mutually
    // exclusive events on the same session.
    const failedRows = audits.filter(
      (r) => r.eventType === "session.analysis.failed",
    );
    expect(failedRows).toHaveLength(0);
  });
});

describe("recordFallbackRefund — free re-analysis", () => {
  it("writes a delta=0 refund row so the user keeps their free slot", async () => {
    const user = await seedUser();
    await setBalance(user.id, 0);
    const session = await seedCompleteSession(user.id);

    // The consume already wrote the delta=0 charge — this is the
    // exact state the worker sees when re-analyzing a session
    // inside the 24h free window.
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 0,
      balanceAfter: 0,
      reason: "interview_charge",
      relatedSessionId: session.id,
    });

    await recordFallbackRefund({
      sessionId: session.id,
      userId: user.id,
      creditsToRefund: 0,
      fallbackReason: "thin_transcript",
    });

    // A single delta=0 refund row matches the delta=0 charge.
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

    // Balance untouched (no actual credits to move).
    const [u] = await db
      .select({ creditBalance: schema.users.creditBalance })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(u?.creditBalance).toBe(0);

    // Headline assertion: the free slot is available again.
    expect(
      await hasConsumedFreeReanalysis({
        sessionId: session.id,
        userId: user.id,
      }),
    ).toBe(false);
  });
});

describe("recordFallbackRefund vs recordAnalysisFailure — clear separation", () => {
  it("does not flip session state (unlike recordAnalysisFailure)", async () => {
    // Pin the load-bearing semantic difference: a fallback
    // refund leaves the session where it is (`complete`). If a
    // future refactor accidentally added a state-advance to
    // `recordFallbackRefund` it'd move the row to `failed` AFTER
    // the report was persisted — the user would land on the
    // failed panel even though they have a complete report row.
    const user = await seedUser();
    await setBalance(user.id, 5);
    const session = await seedCompleteSession(user.id);

    await recordFallbackRefund({
      sessionId: session.id,
      userId: user.id,
      creditsToRefund: 2,
      fallbackReason: "llm_validation_failed",
    });

    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("complete");
  });
});
