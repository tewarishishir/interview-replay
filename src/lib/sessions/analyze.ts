import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { assertTransitionAllowed } from "@/lib/state-machine";
import type { Report } from "@/lib/llm";

/**
 * Side-effect helpers for the analyze-session pipeline.
 * Each one is its own DB transaction with a tightly-
 * scoped responsibility, matching the pattern set by
 * `lib/sessions/transcribe.ts`.
 */

/**
 * Write a single audit log entry for mid-analysis events that don't
 * have a natural home in the existing transaction helpers (e.g.
 * formulaic-opening retry telemetry). Intentionally fire-and-forget
 * from the caller's perspective — the worker wraps this in a best-effort
 * block so a logging failure never aborts the analysis.
 */
export async function logAnalysisAuditEvent(args: {
  userId: string;
  eventType: string;
  eventData: Record<string, unknown>;
}): Promise<void> {
  await db.insert(schema.auditLog).values({
    userId: args.userId,
    eventType: args.eventType,
    eventData: args.eventData,
  });
}

/**
 * Bundle of inputs the analyze worker needs from the DB. Read in
 * one transaction (read-only) so we get a consistent snapshot
 * even if a concurrent edit is in flight on the transcript or
 * artifacts.
 */
export interface AnalysisInputs {
  session: {
    id: string;
    userId: string;
    companyName: string;
    roleTitle: string;
    level: string;
    roundType: "coding" | "system_design" | "behavioral" | "other";
  };
  transcript: {
    redactedText: string;
    editedText: string | null;
    wordCount: number;
    durationSeconds: number;
    fillerWordCount: number;
    transcriptionError: string | null;
  };
  artifacts: Array<{
    /**
     * The artifact row's UUID. Surfaced into the analyze prompt
     * header so the new `per_question_analytics[i].artifact_id`
     * field has a stable target to copy verbatim — the worker
     * then verifies the model's output against this set as
     * guardrail 3.
     */
    id: string;
    artifactType: string;
    content: string | null;
    imageUrl: string | null;
    displayOrder: number;
    /**
     * Where the row came from — drives how the analyze prompt
     * frames the artifact ("the candidate confirmed/added this"
     * vs. "this is an AI-inferred candidate question that the
     * candidate hasn't confirmed").
     */
    source: "user_added" | "ai_inferred";
    aiConfidence: "high" | "medium" | "low" | null;
    /**
     * Whether the candidate has confirmed an AI-inferred row (or
     * edited it, which implies confirmation). Boolean, not a Date,
     * deliberately: this struct is returned from a `step.run`
     * which JSON-serializes its return value, so a `Date` field
     * would silently become an ISO string after the round-trip
     * and any downstream `.getTime()` call would crash. The
     * callers only ever truthy-check this field, so the boolean
     * matches the actual usage AND survives serialization
     * losslessly.
     */
    userConfirmed: boolean;
  }>;
  /**
   * Candidate profile slabs the analyze prompt splices in so the
   * model can ground `per_question_analytics[i].profile_leverage`
   * in real, owned profile items. Only the fields the model needs
   * to identify and label an item are loaded here; the post-
   * response guardrails verify any referenced/suggested UUID
   * against `validProjectIds` / `validStoryIds` (derived from this
   * bundle).
   *
   * Respects the per-section `exclude_projects` and
   * `exclude_stories` profile toggles — a candidate who opted out
   * of either gets an empty list, the same way the rebuild
   * surface honors the toggles.
   *
   * Both arrays are plain objects (no `Date` columns) for easy
   * JSON serialization.
   */
  profile: {
    projects: Array<{
      id: string;
      name: string;
      companyContext: string | null;
      timePeriod: string | null;
      myRole: string | null;
      keyDecisions: string | null;
      outcomesWithMetrics: string | null;
    }>;
    stories: Array<{
      id: string;
      theme: string;
      title: string;
      situation: string | null;
      task: string | null;
      action: string | null;
      result: string | null;
    }>;
  };
  userEmail: string;
}

export class AnalysisInputsNotFoundError extends Error {
  readonly code = "analysis_inputs_not_found";
  constructor(readonly sessionId: string, readonly reason: string) {
    super(`analyze inputs missing for session ${sessionId}: ${reason}`);
    this.name = "AnalysisInputsNotFoundError";
  }
}

/**
 * Load all the data the worker needs in one round-trip per table.
 * Re-validates ownership (the worker is fired by an authenticated
 * route, but the spec is "the worker is the load-bearing guard for
 * the data it touches").
 */
export async function loadAnalysisInputs(args: {
  sessionId: string;
  userId: string;
}): Promise<AnalysisInputs> {
  // `deleted_at IS NULL` so a soft-delete that lands between the
  // route's enqueue and the worker's pick-up surfaces as
  // "inputs not found" and the worker's onFailure refund kicks in.
  // Without this filter we'd happily generate (and bill the LLM
  // for) a report on a session the user has already deleted.
  const [session] = await db
    .select({
      id: schema.interviewSessions.id,
      userId: schema.interviewSessions.userId,
      companyName: schema.interviewSessions.companyName,
      roleTitle: schema.interviewSessions.roleTitle,
      level: schema.interviewSessions.level,
      roundType: schema.interviewSessions.roundType,
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
    throw new AnalysisInputsNotFoundError(
      args.sessionId,
      "session not found, soft-deleted, or not owned by user",
    );
  }

  const [transcript] = await db
    .select({
      redactedText: schema.transcripts.redactedText,
      editedText: schema.transcripts.editedText,
      wordCount: schema.transcripts.wordCount,
      durationSeconds: schema.transcripts.durationSeconds,
      fillerWordCount: schema.transcripts.fillerWordCount,
      transcriptionError: schema.transcripts.transcriptionError,
    })
    .from(schema.transcripts)
    .where(eq(schema.transcripts.sessionId, args.sessionId))
    .limit(1);

  if (!transcript) {
    throw new AnalysisInputsNotFoundError(args.sessionId, "transcript missing");
  }

  // Hide rows the candidate explicitly dismissed on the augment
  // screen — feeding them to the analyzer would re-surface a
  // "question" the candidate has already said wasn't asked, and
  // the report would either repeat the dismissed text verbatim or
  // critique the candidate for an answer to a non-question.
  // Only AI-inferred rows can carry a `dismissedAt` today; the
  // augment UI has no dismiss control on user-added artifacts.
  const artifacts = await db
    .select({
      id: schema.artifacts.id,
      artifactType: schema.artifacts.artifactType,
      content: schema.artifacts.content,
      imageUrl: schema.artifacts.imageUrl,
      displayOrder: schema.artifacts.displayOrder,
      source: schema.artifacts.source,
      aiConfidence: schema.artifacts.aiConfidence,
      userConfirmedAt: schema.artifacts.userConfirmedAt,
    })
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.sessionId, args.sessionId),
        isNull(schema.artifacts.dismissedAt),
      ),
    )
    .orderBy(asc(schema.artifacts.displayOrder), asc(schema.artifacts.createdAt));

  const [user] = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, session.userId))
    .limit(1);

  if (!user) {
    throw new AnalysisInputsNotFoundError(args.sessionId, "owner not found");
  }

  // Profile slabs feed the new `per_question_analytics` prompt
  // section. We honor the per-section `exclude_*` toggles the
  // candidate set on /profile so a user who opted out of having
  // their projects analyzed doesn't suddenly see them leak into
  // the leverage chart. The toggles are stored on `user_profiles`;
  // a missing row (the user never opened the profile editor) is
  // treated as "include everything".
  const [profileRow] = await db
    .select({
      excludeProjects: schema.userProfiles.excludeProjects,
      excludeStories: schema.userProfiles.excludeStories,
    })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, session.userId))
    .limit(1);

  const excludeProjects = profileRow?.excludeProjects ?? false;
  const excludeStories = profileRow?.excludeStories ?? false;

  const projectRowsPromise = excludeProjects
    ? Promise.resolve([] as Array<{
        id: string;
        name: string;
        companyContext: string | null;
        timePeriod: string | null;
        myRole: string | null;
        keyDecisions: string | null;
        outcomesWithMetrics: string | null;
      }>)
    : db
        .select({
          id: schema.projects.id,
          name: schema.projects.name,
          companyContext: schema.projects.companyContext,
          timePeriod: schema.projects.timePeriod,
          myRole: schema.projects.myRole,
          keyDecisions: schema.projects.keyDecisions,
          outcomesWithMetrics: schema.projects.outcomesWithMetrics,
        })
        .from(schema.projects)
        .where(eq(schema.projects.userId, session.userId))
        .orderBy(asc(schema.projects.displayOrder), asc(schema.projects.createdAt));

  const storyRowsPromise = excludeStories
    ? Promise.resolve([] as Array<{
        id: string;
        theme: string;
        title: string;
        situation: string | null;
        task: string | null;
        action: string | null;
        result: string | null;
      }>)
    : db
        .select({
          id: schema.stories.id,
          theme: schema.stories.theme,
          title: schema.stories.title,
          situation: schema.stories.situation,
          task: schema.stories.task,
          action: schema.stories.action,
          result: schema.stories.result,
        })
        .from(schema.stories)
        .where(eq(schema.stories.userId, session.userId))
        .orderBy(asc(schema.stories.theme), asc(schema.stories.createdAt));

  const [projectRows, storyRows] = await Promise.all([
    projectRowsPromise,
    storyRowsPromise,
  ]);

  return {
    session: {
      id: session.id,
      userId: session.userId,
      companyName: session.companyName,
      roleTitle: session.roleTitle,
      level: session.level,
      roundType: session.roundType,
    },
    transcript,
    artifacts: artifacts.map((a) => ({
      id: a.id,
      artifactType: a.artifactType,
      content: a.content,
      imageUrl: a.imageUrl,
      displayOrder: a.displayOrder,
      source: a.source,
      aiConfidence: a.aiConfidence,
      userConfirmed: a.userConfirmedAt !== null,
    })),
    profile: {
      projects: projectRows,
      stories: storyRows,
    },
    userEmail: user.email,
  };
}

/**
 * Persist the report and advance the session into `complete`. Each
 * successful analysis APPENDS a new `reports` row — re-analyses are
 * not destructive, since the user paid for each run and is entitled
 * to view prior versions. The "current" report is the most-recent
 * row by `created_at` (served by `reports_session_created_idx`); the
 * session detail page lists EVERY earlier row in a "Previous analyses"
 * sidebar so the user can navigate back to any prior paid-for run.
 * The state machine asserts the transition is legal before we touch
 * the row.
 */
export async function persistReportAndComplete(args: {
  sessionId: string;
  userId: string;
  report: Report;
  modelVersion: string;
  rubricVersion: string;
}): Promise<{ reportId: string }> {
  assertTransitionAllowed("analyzing", "complete");

  return db.transaction(async (tx) => {
    const [report] = await tx
      .insert(schema.reports)
      .values({
        sessionId: args.sessionId,
        reportJson: args.report,
        modelVersion: args.modelVersion,
        rubricVersion: args.rubricVersion,
      })
      .returning({ id: schema.reports.id });

    if (!report) {
      throw new Error(
        `persistReportAndComplete: reports INSERT returned no row for session ${args.sessionId}`,
      );
    }

    // CAS on `state` so a concurrent delete (state moved to
    // `deleted`) doesn't get clobbered by us writing `complete`.
    const [advanced] = await tx
      .update(schema.interviewSessions)
      .set({ state: "complete", updatedAt: new Date() })
      .where(
        and(
          eq(schema.interviewSessions.id, args.sessionId),
          eq(schema.interviewSessions.state, "analyzing"),
        ),
      )
      .returning({ id: schema.interviewSessions.id });

    if (!advanced) {
      // Session was deleted (or moved to `failed`) under us. Roll
      // back the report write so we don't have a report attached
      // to a state-incoherent session.
      throw new Error(
        `persistReportAndComplete: state guard failed for session ${args.sessionId}`,
      );
    }

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "session.report.completed",
      eventData: {
        sessionId: args.sessionId,
        reportId: report.id,
        modelVersion: args.modelVersion,
        rubricVersion: args.rubricVersion,
      },
    });

    // (Referral bonus payout used to fire here on the user's first
    // completed analysis. The trigger moved to the referee's first
    // SUCCEEDED purchase — see `awardReferrerOnFirstPurchase` and
    // its caller in the Stripe webhook handler. Free-credit-only
    // signups no longer pay a bonus.)

    return { reportId: report.id };
  });
}

/**
 * Refund credits + write a `session.report.fallback` audit row for
 * a "fallback" analysis — one where we built a valid Report
 * locally instead of letting the analysis fail. The session is
 * already in `complete` by the time this runs (`persistReportAndComplete`
 * advanced it) so we DO NOT touch state.
 *
 * Why a separate helper from `recordAnalysisFailure`:
 *   - `recordAnalysisFailure` is gated on `analyzing -> failed`.
 *     A fallback persistence has already moved the row to
 *     `complete`, so the CAS would no-op and the refund would
 *     never fire.
 *   - The audit event type is different — `session.report.fallback`
 *     is a successful-but-degraded persistence, not a failure.
 *     Ops dashboards split the two so a thin-transcript day
 *     doesn't show up as an analysis-failure spike.
 *
 * Free re-analysis branch mirrors `recordAnalysisFailure` exactly:
 * we write a delta=0 `interview_refund` ledger row so
 * `hasConsumedFreeReanalysis` sees the cancellation and restores
 * the user's one-shot free slot. Without this, a thin-transcript
 * fallback on a free re-run would permanently burn the user's
 * free slot.
 *
 * Idempotency: this helper is INTENDED to be called exactly once
 * per analysis attempt, immediately after `persistReportAndComplete`.
 * It does NOT guard against a double-call (no state CAS available
 * here), so callers must not re-invoke on retry.
 */
export async function recordFallbackRefund(args: {
  sessionId: string;
  userId: string;
  creditsToRefund: number;
  fallbackReason: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    if (args.creditsToRefund > 0) {
      // Lock the user row, bump the balance, write the ledger.
      const lockedUser = await tx.execute<{ credit_balance: number }>(sql`
        SELECT credit_balance
        FROM ${schema.users}
        WHERE id = ${args.userId} AND deleted_at IS NULL
        FOR UPDATE
      `);
      const userRow = lockedUser.rows[0];
      if (userRow) {
        const newBalance = userRow.credit_balance + args.creditsToRefund;
        await tx
          .update(schema.users)
          .set({ creditBalance: newBalance, updatedAt: new Date() })
          .where(eq(schema.users.id, args.userId));

        await tx.insert(schema.creditTransactions).values({
          userId: args.userId,
          delta: args.creditsToRefund,
          balanceAfter: newBalance,
          reason: "interview_refund",
          relatedSessionId: args.sessionId,
        });
      }
    } else {
      // Free re-analysis fallback: delta=0 refund row mirrors the
      // delta=0 charge so `hasConsumedFreeReanalysis` sees net=0
      // and restores the slot.
      const [user] = await tx
        .select({ creditBalance: schema.users.creditBalance })
        .from(schema.users)
        .where(eq(schema.users.id, args.userId))
        .limit(1);
      await tx.insert(schema.creditTransactions).values({
        userId: args.userId,
        delta: 0,
        balanceAfter: user?.creditBalance ?? 0,
        reason: "interview_refund",
        relatedSessionId: args.sessionId,
      });
    }

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "session.report.fallback",
      eventData: {
        sessionId: args.sessionId,
        reason: args.fallbackReason,
        creditsRefunded: args.creditsToRefund,
      },
    });
  });
}

/**
 * On terminal failure: mark the session as `failed`, refund the
 * credits we charged (unless this was a free re-analysis), and
 * write the audit row. Idempotent: if the session is already
 * `failed`, no-op.
 *
 * Free re-analysis path (creditsToRefund === 0): we still write a
 * compensating delta=0 `interview_refund` ledger row. This is the
 * audit trail the `hasConsumedFreeReanalysis` helper consumes to
 * decide "did the user actually receive the value of their free
 * re-run?". Without this row, a worker failure on a free re-run
 * would permanently burn the user's free slot — they get charged
 * (with delta=0) but never see a report, AND the next click is
 * billed at full price. Writing the refund preserves the user's
 * one-shot guarantee across infra failures.
 */
export async function recordAnalysisFailure(args: {
  sessionId: string;
  userId: string;
  errorMessage: string;
  creditsToRefund: number;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock the session row with a CAS on the state — only flip
    // analyzing → failed. Anything else (deleted, complete from a
    // prior successful attempt) is a no-op.
    const [advanced] = await tx
      .update(schema.interviewSessions)
      .set({ state: "failed", updatedAt: new Date() })
      .where(
        and(
          eq(schema.interviewSessions.id, args.sessionId),
          eq(schema.interviewSessions.state, "analyzing"),
        ),
      )
      .returning({ id: schema.interviewSessions.id });

    if (!advanced) return;

    if (args.creditsToRefund > 0) {
      // Lock the user row, increment the balance, write a
      // compensating ledger entry. Reason `interview_refund`
      // matches the spec's intent (credits returned because the
      // analysis we charged for didn't deliver).
      const lockedUser = await tx.execute<{ credit_balance: number }>(sql`
        SELECT credit_balance
        FROM ${schema.users}
        WHERE id = ${args.userId} AND deleted_at IS NULL
        FOR UPDATE
      `);
      const userRow = lockedUser.rows[0];
      if (userRow) {
        const newBalance = userRow.credit_balance + args.creditsToRefund;
        await tx
          .update(schema.users)
          .set({ creditBalance: newBalance, updatedAt: new Date() })
          .where(eq(schema.users.id, args.userId));

        await tx.insert(schema.creditTransactions).values({
          userId: args.userId,
          delta: args.creditsToRefund,
          balanceAfter: newBalance,
          reason: "interview_refund",
          relatedSessionId: args.sessionId,
        });
      }
    } else {
      // Free re-analysis rollback: write a delta=0 audit row so
      // `hasConsumedFreeReanalysis` (which compares delta=0
      // charges vs. delta=0 refunds) sees the cancellation and
      // restores the user's free slot. Read the current balance
      // (no FOR UPDATE — we're not modifying it) so the row's
      // `balanceAfter` accurately reflects the snapshot.
      const [user] = await tx
        .select({ creditBalance: schema.users.creditBalance })
        .from(schema.users)
        .where(eq(schema.users.id, args.userId))
        .limit(1);
      await tx.insert(schema.creditTransactions).values({
        userId: args.userId,
        delta: 0,
        balanceAfter: user?.creditBalance ?? 0,
        reason: "interview_refund",
        relatedSessionId: args.sessionId,
      });
    }

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "session.analysis.failed",
      eventData: {
        sessionId: args.sessionId,
        error: args.errorMessage,
        creditsRefunded: args.creditsToRefund,
      },
    });
  });
}
