import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { assertTransitionAllowed } from "@/lib/state-machine";

/**
 * Self-hosted mode: the app is free. Credits are not consumed.
 * This module preserves the same API surface so callers don't need
 * changes, but skips all balance checks and ledger writes.
 */

export class InsufficientCreditsError extends Error {
  readonly code = "insufficient_credits";
  readonly status = 402;
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super(
      `Need ${required} credit${required === 1 ? "" : "s"} but only ` +
        `${available} available.`,
    );
    this.name = "InsufficientCreditsError";
  }
}

export class SessionStateMismatchError extends Error {
  readonly code = "session_state_mismatch";
  readonly status = 409;
  constructor(readonly state: string) {
    super(
      `Session is in state '${state}'; analysis can only be started from ` +
        `'review' or 'complete'.`,
    );
    this.name = "SessionStateMismatchError";
  }
}

export class FreeReanalysisAlreadyUsedError extends Error {
  readonly code = "free_reanalysis_already_used";
  readonly status = 409;
  constructor(readonly sessionId: string) {
    super("Free re-run limit reached for this session.");
    this.name = "FreeReanalysisAlreadyUsedError";
  }
}

export class SessionNotFoundError extends Error {
  readonly code = "session_not_found";
  readonly status = 404;
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} not found.`);
    this.name = "SessionNotFoundError";
  }
}

export interface ConsumeCreditsArgs {
  userId: string;
  sessionId: string;
  creditsRequired: number;
}

export interface ConsumeCreditsResult {
  balanceAfter: number;
  transactionId: number;
}

/**
 * Self-hosted: always succeeds. Just advances the session state to
 * `analyzing` without consuming any credits.
 */
export async function consumeCreditsForAnalysis(
  args: ConsumeCreditsArgs,
): Promise<ConsumeCreditsResult> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({
        id: schema.interviewSessions.id,
        state: schema.interviewSessions.state,
      })
      .from(schema.interviewSessions)
      .where(
        and(
          eq(schema.interviewSessions.id, args.sessionId),
          eq(schema.interviewSessions.userId, args.userId),
          isNull(schema.interviewSessions.deletedAt),
        ),
      )
      .limit(1);

    if (!session) {
      throw new SessionNotFoundError(args.sessionId);
    }

    if (session.state !== "review" && session.state !== "complete") {
      throw new SessionStateMismatchError(session.state);
    }

    assertTransitionAllowed(session.state, "analyzing");

    await tx
      .update(schema.interviewSessions)
      .set({ state: "analyzing", updatedAt: new Date() })
      .where(
        and(
          eq(schema.interviewSessions.id, args.sessionId),
          sql`${schema.interviewSessions.state} IN ('review', 'complete')`,
        ),
      );

    return { balanceAfter: 999999, transactionId: 0 };
  });
}

/**
 * Self-hosted: no-op refund (nothing was charged).
 */
export async function refundConsumedCredits(_args: {
  userId: string;
  sessionId: string;
  creditsToRefund: number;
  priorState: string;
  reason?: string;
}): Promise<{ applied: boolean; balanceAfter: number | null }> {
  return { applied: true, balanceAfter: 999999 };
}

export interface ChargeAndDeleteResult {
  creditsCharged: number;
  balanceAfter: number;
  applied: boolean;
  previousState: string | null;
}

/**
 * Self-hosted: soft-delete the session without charging credits.
 */
export async function chargeTranscriptionFeeAndDelete(args: {
  userId: string;
  sessionId: string;
  creditsRequired: number;
}): Promise<ChargeAndDeleteResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: schema.interviewSessions.id,
        state: schema.interviewSessions.state,
      })
      .from(schema.interviewSessions)
      .where(
        and(
          eq(schema.interviewSessions.id, args.sessionId),
          eq(schema.interviewSessions.userId, args.userId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new SessionNotFoundError(args.sessionId);
    }

    if (row.state === "deleted") {
      return {
        creditsCharged: 0,
        balanceAfter: 999999,
        applied: false,
        previousState: "deleted",
      };
    }

    assertTransitionAllowed(row.state, "deleted");

    await tx
      .update(schema.interviewSessions)
      .set({
        state: "deleted",
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.interviewSessions.id, args.sessionId),
          eq(schema.interviewSessions.userId, args.userId),
        ),
      );

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "session.deleted",
      eventData: {
        sessionId: args.sessionId,
        previousState: row.state,
        transcriptionFeeRequested: 0,
        transcriptionFeeCharged: 0,
      },
    });

    return {
      creditsCharged: 0,
      balanceAfter: 999999,
      applied: true,
      previousState: row.state,
    };
  });
}
