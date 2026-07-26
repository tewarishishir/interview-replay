/**
 * Tests for the atomic credit-consumption helper. The headline
 * scenario is "concurrent requests don't double-spend" — we
 * fire two parallel `consumeCreditsForAnalysis` calls against the
 * same user and assert exactly one succeeds when the user has
 * enough credits for ONE call but not both.
 *
 * The other tests cover:
 *   - Happy-path balance + ledger + state advance.
 *   - Insufficient-credits rejection.
 *   - Re-analysis path (creditsRequired === 0) succeeds without
 *     touching the balance column.
 *   - State-mismatch rejection (session not in `review` /
 *     `complete`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";
import {
  consumeCreditsForAnalysis,
  FreeReanalysisAlreadyUsedError,
  InsufficientCreditsError,
  refundConsumedCredits,
  SessionNotFoundError,
  SessionStateMismatchError,
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
  state:
    | "review"
    | "complete"
    | "created"
    | "analyzing" = "review",
) => {
  const row = await createSession({
    userId,
    companyName: "Stripe",
    roleTitle: "Backend Engineer",
    level: "senior",
    roundType: "coding",
    scheduledAt: null,
  });
  if (state !== "created") {
    await db
      .update(schema.interviewSessions)
      .set({ state })
      .where(eq(schema.interviewSessions.id, row.id));
  }
  return row;
};

const setUserBalance = async (userId: string, balance: number) => {
  await db
    .update(schema.users)
    .set({ creditBalance: balance })
    .where(eq(schema.users.id, userId));
};

const getUserBalance = async (userId: string) => {
  const [row] = await db
    .select({ creditBalance: schema.users.creditBalance })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row?.creditBalance ?? null;
};

describe("consumeCreditsForAnalysis — happy paths", () => {
  it("debits credits, writes a ledger row, and flips the session to analyzing", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 5);
    const session = await seedSession(user.id, "review");

    const result = await consumeCreditsForAnalysis({
      userId: user.id,
      sessionId: session.id,
      creditsRequired: 2,
    });

    expect(result.balanceAfter).toBe(3);
    expect(await getUserBalance(user.id)).toBe(3);

    const [refreshed] = await db
      .select({
        state: schema.interviewSessions.state,
        creditsCharged: schema.interviewSessions.creditsCharged,
      })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id))
      .limit(1);
    expect(refreshed?.state).toBe("analyzing");
    expect(refreshed?.creditsCharged).toBe(2);

    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.userId, user.id));
    // First row is the signup_bonus, second is our charge.
    expect(ledger).toHaveLength(2);
    const charge = ledger.find((r) => r.reason === "interview_charge");
    expect(charge).toBeDefined();
    expect(charge?.delta).toBe(-2);
    expect(charge?.balanceAfter).toBe(3);
    expect(charge?.relatedSessionId).toBe(session.id);
  });

  it("re-analysis with creditsRequired=0 still flips state and writes a delta=0 ledger row", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 0);
    // Re-analysis: starting state is `complete` (the user already
    // has a report and is asking for it to be regenerated).
    const session = await seedSession(user.id, "complete");

    const result = await consumeCreditsForAnalysis({
      userId: user.id,
      sessionId: session.id,
      creditsRequired: 0,
    });

    expect(result.balanceAfter).toBe(0);
    expect(await getUserBalance(user.id)).toBe(0);

    const [refreshed] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id))
      .limit(1);
    expect(refreshed?.state).toBe("analyzing");

    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_charge"));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.delta).toBe(0);
  });

  // H1: a free re-analysis must NOT clobber `credits_charged` to 0.
  it("free re-analysis (creditsRequired=0) preserves the prior creditsCharged on the session row", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 4);
    const session = await seedSession(user.id, "review");

    // First analysis: 2 credits, complete it (we simulate the
    // `complete` transition by hand here so we can re-analyze).
    await consumeCreditsForAnalysis({
      userId: user.id,
      sessionId: session.id,
      creditsRequired: 2,
    });
    await db
      .update(schema.interviewSessions)
      .set({ state: "complete" })
      .where(eq(schema.interviewSessions.id, session.id));

    const [afterFirst] = await db
      .select({ creditsCharged: schema.interviewSessions.creditsCharged })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id))
      .limit(1);
    expect(afterFirst?.creditsCharged).toBe(2);

    // Free re-analysis at 0 credits.
    await consumeCreditsForAnalysis({
      userId: user.id,
      sessionId: session.id,
      creditsRequired: 0,
    });

    const [afterReanalysis] = await db
      .select({ creditsCharged: schema.interviewSessions.creditsCharged })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id))
      .limit(1);
    // The historic billing fingerprint is preserved.
    expect(afterReanalysis?.creditsCharged).toBe(2);
  });
});

describe("consumeCreditsForAnalysis — guards", () => {
  it("rejects with InsufficientCreditsError when balance is below required", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 1);
    const session = await seedSession(user.id, "review");

    await expect(
      consumeCreditsForAnalysis({
        userId: user.id,
        sessionId: session.id,
        creditsRequired: 3,
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    // Balance untouched, session still in review.
    expect(await getUserBalance(user.id)).toBe(1);
    const [refreshed] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id))
      .limit(1);
    expect(refreshed?.state).toBe("review");
  });

  it("rejects with SessionStateMismatchError when session is in `created`", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 5);
    const session = await seedSession(user.id, "created");

    await expect(
      consumeCreditsForAnalysis({
        userId: user.id,
        sessionId: session.id,
        creditsRequired: 1,
      }),
    ).rejects.toBeInstanceOf(SessionStateMismatchError);
    expect(await getUserBalance(user.id)).toBe(5);
  });

  it("rejects with SessionStateMismatchError when session is already in `analyzing`", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 5);
    const session = await seedSession(user.id, "analyzing");

    await expect(
      consumeCreditsForAnalysis({
        userId: user.id,
        sessionId: session.id,
        creditsRequired: 1,
      }),
    ).rejects.toBeInstanceOf(SessionStateMismatchError);
  });

  // L1: a session that doesn't belong to the user (or doesn't exist
  // at all) must surface a typed `SessionNotFoundError` so the route
  // can return 404 (no information leakage) rather than a generic 500.
  it("rejects with SessionNotFoundError when the session belongs to a different user", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    await setUserBalance(bob.id, 5);
    const sessionAlice = await seedSession(alice.id, "review");

    await expect(
      consumeCreditsForAnalysis({
        userId: bob.id,
        sessionId: sessionAlice.id,
        creditsRequired: 1,
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);

    expect(await getUserBalance(bob.id)).toBe(5);
  });

  // H4: soft-deleted sessions must look identical to "doesn't exist".
  it("rejects with SessionNotFoundError when the session is soft-deleted", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 5);
    const session = await seedSession(user.id, "review");
    await db
      .update(schema.interviewSessions)
      .set({ deletedAt: new Date(), state: "deleted" })
      .where(eq(schema.interviewSessions.id, session.id));

    await expect(
      consumeCreditsForAnalysis({
        userId: user.id,
        sessionId: session.id,
        creditsRequired: 1,
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);

    expect(await getUserBalance(user.id)).toBe(5);
  });
});

// C3: rollback path. After a successful consume we may need to undo
// it because a downstream step (e.g. job runner enqueue) failed. The
// helper restores credits AND walks the session state back.
describe("refundConsumedCredits", () => {
  it("re-credits the user balance, walks the session back, writes a refund ledger row", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 4);
    const session = await seedSession(user.id, "review");

    await consumeCreditsForAnalysis({
      userId: user.id,
      sessionId: session.id,
      creditsRequired: 2,
    });
    expect(await getUserBalance(user.id)).toBe(2);

    const result = await refundConsumedCredits({
      userId: user.id,
      sessionId: session.id,
      creditsToRefund: 2,
      priorState: "review",
    });

    expect(result.applied).toBe(true);
    expect(result.balanceAfter).toBe(4);
    expect(await getUserBalance(user.id)).toBe(4);

    const [refreshed] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id))
      .limit(1);
    expect(refreshed?.state).toBe("review");

    const refundRows = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_refund"));
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]?.delta).toBe(2);
    expect(refundRows[0]?.balanceAfter).toBe(4);
    expect(refundRows[0]?.relatedSessionId).toBe(session.id);
  });

  it("free re-analysis rollback: walks state back, writes a delta=0 audit row, leaves balance alone", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 1);
    const session = await seedSession(user.id, "complete");

    await consumeCreditsForAnalysis({
      userId: user.id,
      sessionId: session.id,
      creditsRequired: 0,
    });

    const result = await refundConsumedCredits({
      userId: user.id,
      sessionId: session.id,
      creditsToRefund: 0,
      priorState: "complete",
    });

    expect(result.applied).toBe(true);
    expect(await getUserBalance(user.id)).toBe(1);

    const [refreshed] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id))
      .limit(1);
    expect(refreshed?.state).toBe("complete");

    const refundRows = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_refund"));
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]?.delta).toBe(0);
  });

  it("is a no-op when the session has already advanced past `analyzing`", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 4);
    const session = await seedSession(user.id, "review");
    await consumeCreditsForAnalysis({
      userId: user.id,
      sessionId: session.id,
      creditsRequired: 2,
    });
    // A successful worker landed `complete` in between.
    await db
      .update(schema.interviewSessions)
      .set({ state: "complete" })
      .where(eq(schema.interviewSessions.id, session.id));

    const result = await refundConsumedCredits({
      userId: user.id,
      sessionId: session.id,
      creditsToRefund: 2,
      priorState: "review",
    });

    expect(result.applied).toBe(false);
    // Balance NOT restored — the report exists; refunding here
    // would give the user a free analysis.
    expect(await getUserBalance(user.id)).toBe(2);

    const refundRows = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_refund"));
    expect(refundRows).toHaveLength(0);
  });
});

// The route layer pre-checks "has free already been used", but a
// concurrent burst can land two requests past that check before
// either has committed a ledger row. The transactional invariant
// inside `consumeCreditsForAnalysis` is the authoritative defense;
// these tests pin it under the FOR UPDATE lock.
//
// Invariant: for any session, at most one `interview_charge` row
// with `delta = 0` may ever be written. A delta=0 consume that
// would violate this throws `FreeReanalysisAlreadyUsedError`.
describe("consumeCreditsForAnalysis — one-free-per-session invariant (TOCTOU defense)", () => {
  it("rejects with FreeReanalysisAlreadyUsedError when a prior delta=0 charge already exists for the session", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 5);
    const session = await seedSession(user.id, "complete");

    // One prior delta=0 row — the session's free re-run is spent.
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 0,
      balanceAfter: 5,
      reason: "interview_charge",
      relatedSessionId: session.id,
    });

    await expect(
      consumeCreditsForAnalysis({
        userId: user.id,
        sessionId: session.id,
        creditsRequired: 0,
      }),
    ).rejects.toBeInstanceOf(FreeReanalysisAlreadyUsedError);

    // No new ledger row written, no state move.
    const charges = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_charge"));
    expect(charges).toHaveLength(1);
    const [refreshed] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(refreshed?.state).toBe("complete");
  });

  it("ignores AGE of the prior delta=0 row — one free re-run per session lifetime, not per 24h", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 5);
    const session = await seedSession(user.id, "complete");

    // A delta=0 row from 30 hours ago (well outside the old 24h
    // free window). Under the previous policy this wouldn't count;
    // under the new "one per session ever" rule it MUST.
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 0,
      balanceAfter: 5,
      reason: "interview_charge",
      relatedSessionId: session.id,
      createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
    });

    await expect(
      consumeCreditsForAnalysis({
        userId: user.id,
        sessionId: session.id,
        creditsRequired: 0,
      }),
    ).rejects.toBeInstanceOf(FreeReanalysisAlreadyUsedError);
  });

  it("does NOT count prior PAID charges toward the free invariant", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 5);
    const session = await seedSession(user.id, "complete");

    // Initial paid analysis already happened (delta < 0).
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: -2,
      balanceAfter: 5,
      reason: "interview_charge",
      relatedSessionId: session.id,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The free re-run is still available — paid charges don't
    // consume the free slot.
    await consumeCreditsForAnalysis({
      userId: user.id,
      sessionId: session.id,
      creditsRequired: 0,
    });

    const charges = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_charge"));
    expect(charges).toHaveLength(2);
    const freeCharges = charges.filter((c) => c.delta === 0);
    expect(freeCharges).toHaveLength(1);
  });

  it("does NOT cap PAID re-runs — only the delta=0 path is one-shot", async () => {
    const user = await seedUser();
    await setUserBalance(user.id, 10);
    const session = await seedSession(user.id, "complete");

    // Free re-run already burned.
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 0,
      balanceAfter: 10,
      reason: "interview_charge",
      relatedSessionId: session.id,
    });

    // A paid re-run is still allowed.
    await consumeCreditsForAnalysis({
      userId: user.id,
      sessionId: session.id,
      creditsRequired: 2,
    });

    expect(await getUserBalance(user.id)).toBe(8);
    const charges = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_charge"));
    expect(charges).toHaveLength(2);
  });

  it("ALLOWS a free re-run after a prior free re-run was rolled back (charge=1, refund=1, net=0)", async () => {
    // Recovery flow: the first free re-run charged delta=0, the
    // worker / job runner enqueue failed and a delta=0 refund row
    // landed via refundConsumedCredits or recordAnalysisFailure.
    // The net count is 0 — the user kept their free slot — so a
    // retry must succeed. This is the load-bearing fix for
    // "transient infra failure permanently burns the user's free
    // re-run".
    const user = await seedUser();
    await setUserBalance(user.id, 5);
    const session = await seedSession(user.id, "complete");

    // Burn + roll back the original free re-run.
    await consumeCreditsForAnalysis({
      userId: user.id,
      sessionId: session.id,
      creditsRequired: 0,
    });
    await refundConsumedCredits({
      userId: user.id,
      sessionId: session.id,
      creditsToRefund: 0,
      priorState: "complete",
    });

    // Retry: net count is 0, so the invariant must NOT reject.
    await consumeCreditsForAnalysis({
      userId: user.id,
      sessionId: session.id,
      creditsRequired: 0,
    });

    const charges = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_charge"));
    expect(charges.filter((c) => c.delta === 0)).toHaveLength(2);
    const refunds = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_refund"));
    expect(refunds.filter((r) => r.delta === 0)).toHaveLength(1);
  });

  it("REJECTS a free re-run when there are more delta=0 charges than refunds (net > 0)", async () => {
    // Counterpart to the recovery test: 2 prior free charges and
    // 1 prior free refund means one free re-run is currently
    // active on the books. A new attempt must reject.
    const user = await seedUser();
    await setUserBalance(user.id, 5);
    const session = await seedSession(user.id, "complete");

    for (let i = 0; i < 2; i++) {
      await db.insert(schema.creditTransactions).values({
        userId: user.id,
        delta: 0,
        balanceAfter: 5,
        reason: "interview_charge",
        relatedSessionId: session.id,
      });
    }
    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: 0,
      balanceAfter: 5,
      reason: "interview_refund",
      relatedSessionId: session.id,
    });

    await expect(
      consumeCreditsForAnalysis({
        userId: user.id,
        sessionId: session.id,
        creditsRequired: 0,
      }),
    ).rejects.toBeInstanceOf(FreeReanalysisAlreadyUsedError);
  });

  it("ignores delta=0 ledger rows belonging to a DIFFERENT user (ownership scoping)", async () => {
    // Defense in depth: the user_id filter inside the invariant
    // must prevent a delta=0 row stamped with another user from
    // being mistaken for "this user already used their free run".
    // A null/anonymized user_id (post-deletion scrub) likewise
    // doesn't count.
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    await setUserBalance(bob.id, 5);
    const sessionBob = await seedSession(bob.id, "complete");

    // Stamp a delta=0 charge against the same session id but with
    // alice's user id (an artificial scenario — the consume helper
    // would never write this — but it pins the WHERE clause).
    await db.insert(schema.creditTransactions).values({
      userId: alice.id,
      delta: 0,
      balanceAfter: 0,
      reason: "interview_charge",
      relatedSessionId: sessionBob.id,
    });

    // Bob's free re-run is still available.
    await consumeCreditsForAnalysis({
      userId: bob.id,
      sessionId: sessionBob.id,
      creditsRequired: 0,
    });
  });

  it("two concurrent free re-analyses serialize: exactly one delta=0 row lands", async () => {
    // Headline TOCTOU defense: two parallel consumes with
    // creditsRequired=0 must serialize at the FOR UPDATE lock so
    // exactly ONE writes the delta=0 row; the other re-checks
    // under the lock, sees the row, and rejects with
    // FreeReanalysisAlreadyUsedError (or loses the state CAS).
    const user = await seedUser();
    await setUserBalance(user.id, 5);
    const session = await seedSession(user.id, "complete");

    const results = await Promise.allSettled([
      consumeCreditsForAnalysis({
        userId: user.id,
        sessionId: session.id,
        creditsRequired: 0,
      }),
      consumeCreditsForAnalysis({
        userId: user.id,
        sessionId: session.id,
        creditsRequired: 0,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The rejection must be either the free-already-used error OR
    // a state mismatch (whichever guard fires first under the
    // serialized order). Both are correct outcomes — the loser
    // doesn't burn a second free re-run.
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(
      reason instanceof FreeReanalysisAlreadyUsedError ||
        reason instanceof SessionStateMismatchError,
    ).toBe(true);

    // Authoritative invariant: exactly ONE delta=0 row landed.
    const charges = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_charge"));
    const freeCharges = charges.filter((c) => c.delta === 0);
    expect(freeCharges).toHaveLength(1);
  });
});

describe("consumeCreditsForAnalysis — concurrency (no double-spend)", () => {
  it("two concurrent calls with balance for ONE serialize cleanly: one succeeds, the other fails with insufficient", async () => {
    const user = await seedUser();
    // Balance for exactly ONE 2-credit run.
    await setUserBalance(user.id, 2);

    // Two distinct sessions so the session-state CAS doesn't
    // mask the credit-double-spend test. Both want 2 credits.
    const sessionA = await seedSession(user.id, "review");
    const sessionB = await seedSession(user.id, "review");

    const results = await Promise.allSettled([
      consumeCreditsForAnalysis({
        userId: user.id,
        sessionId: sessionA.id,
        creditsRequired: 2,
      }),
      consumeCreditsForAnalysis({
        userId: user.id,
        sessionId: sessionB.id,
        creditsRequired: 2,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The rejection must be InsufficientCredits, not a generic
    // database race. This is the core "atomic + serialized"
    // behavior the FOR UPDATE lock buys us.
    expect(
      (rejected[0] as PromiseRejectedResult).reason,
    ).toBeInstanceOf(InsufficientCreditsError);

    // Balance landed at zero (one 2-credit charge applied).
    expect(await getUserBalance(user.id)).toBe(0);

    // Exactly one charge ledger row.
    const charges = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.reason, "interview_charge"));
    expect(charges).toHaveLength(1);
    expect(charges[0]?.delta).toBe(-2);
    expect(charges[0]?.balanceAfter).toBe(0);

    // Exactly one session in `analyzing`; the other stayed in `review`.
    const allSessions = await db
      .select({
        id: schema.interviewSessions.id,
        state: schema.interviewSessions.state,
      })
      .from(schema.interviewSessions);
    const analyzing = allSessions.filter((s) => s.state === "analyzing");
    const review = allSessions.filter((s) => s.state === "review");
    expect(analyzing).toHaveLength(1);
    expect(review).toHaveLength(1);
  });
});
