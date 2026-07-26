import "server-only";

import { and, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import {
  OUTCOME_TYPES,
  type OutcomeType,
  type SessionOutcome,
} from "@/lib/db/schema";

/**
 * Server-side query + mutation helpers for the `session_outcomes`
 * table. The API routes wrap these with auth, rate-limiting, and
 * Zod parsing; the reminder cron uses the read helpers directly.
 *
 * Every write helper writes its own audit log entry inside the
 * same transaction so a partial failure can never leave the
 * outcome row updated without a corresponding audit trail (or vice
 * versa). The audit `event_type` namespace is `outcome.*` —
 * `recorded`, `updated`, `deleted`, `reminder_sent` — and the
 * payload is intentionally schema-light (session_id, outcome_type,
 * counts) so the audit table can absorb a power user's outcome
 * history without bloating into multi-MB rows.
 *
 * The text fields (`feedback_received`, `reflection_notes`,
 * `would_change`) are deliberately NEVER included in audit
 * payloads — the audit log is operational, not compliance-grade
 * for "show me what the user typed two weeks ago".
 */

/**
 * Audit event names. Centralized to keep the reminder-dedupe query
 * (which filters audit_log by event_type) honest with the
 * production writers.
 */
export const OUTCOME_AUDIT_EVENTS = {
  recorded: "outcome.recorded",
  updated: "outcome.updated",
  deleted: "outcome.deleted",
  reminderSent: "outcome.reminder_sent",
} as const;

/* ──────────────────────────────────────────────────────────── */
/*                       Zod input schemas                       */
/* ──────────────────────────────────────────────────────────── */

const trimmedNullable = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .transform((s) => (s.length === 0 ? null : s))
    .nullable()
    .optional();

/**
 * Optional ISO-8601 date string, with sanity bounds. Zod's
 * `.datetime()` only checks shape — without bounds, a candidate
 * could submit `1900-01-01` or `9999-12-31` and the row would
 * happily store it. We refuse:
 *
 *   - dates whose year is < 2020 (InterviewReplay didn't exist; this is
 *     almost certainly a typo or a date-picker glitch)
 *   - dates more than 24 hours in the future relative to the
 *     server clock (you can't have heard back tomorrow)
 *
 * The 24-hour future buffer accommodates user/server timezone
 * skew without letting through "I heard back in 2099". Cross-
 * checking against the session's createdAt (you can't have heard
 * back BEFORE the interview) happens in the route handler where
 * we already have the session row in scope.
 *
 * `Date.now()` in the refine is evaluated per-parse, not at
 * module load, so a long-running server doesn't drift its bounds.
 */
const dateNullable = z
  .string()
  .datetime({ message: "Must be ISO 8601 (e.g. 2026-05-08T00:00:00Z)" })
  .refine(
    (s) => {
      const t = Date.parse(s);
      if (!Number.isFinite(t)) return false;
      const d = new Date(t);
      if (d.getUTCFullYear() < 2020) return false;
      if (t > Date.now() + 24 * 60 * 60 * 1000) return false;
      return true;
    },
    { message: "Date must be between 2020 and tomorrow." },
  )
  .nullable()
  .optional();

/**
 * POST body. Same shape as PATCH; the difference is that `POST`
 * inserts (and 409s if a row already exists), `PATCH` updates an
 * existing row (and 404s if no row exists).
 *
 * `outcome_type` is REQUIRED on POST, optional on PATCH (so users
 * can change just one field without re-typing everything). The
 * route handlers narrow accordingly via two distinct schemas
 * exported below.
 */
const baseOutcomeBodySchema = z.object({
  outcome_type: z.enum(OUTCOME_TYPES).optional(),
  outcome_received_at: dateNullable,
  next_round_type: trimmedNullable(200),
  feedback_received: trimmedNullable(5000),
  reflection_notes: trimmedNullable(5000),
  would_change: trimmedNullable(500),
  asked_for_feedback: z.boolean().optional(),
});

/**
 * Behavioural rule shared by POST and PATCH: `next_round_type`
 * only makes sense for `advanced_to_next_round`. We strip it
 * silently for any other outcome type rather than 400-ing — the
 * UI may have left a stale value in the field after the user
 * switched their selection. Stripping here keeps the rule in one
 * place; the front-end is free to also clear the value on toggle.
 *
 * Generic over the input type so Zod's `.transform()` chain
 * preserves the full inferred shape (without the generic, the
 * transform's return type collapses to just the two fields it
 * mentions, and downstream consumers lose access to
 * `feedback_received` etc.).
 */
const stripNextRoundForNonAdvanced = <
  T extends {
    outcome_type?: OutcomeType;
    next_round_type?: string | null | undefined;
  },
>(
  data: T,
): T => {
  if (data.outcome_type && data.outcome_type !== "advanced_to_next_round") {
    return { ...data, next_round_type: null };
  }
  return data;
};

export const createOutcomeBodySchema = baseOutcomeBodySchema
  .extend({
    outcome_type: z.enum(OUTCOME_TYPES),
  })
  .transform(stripNextRoundForNonAdvanced);

export const updateOutcomeBodySchema = baseOutcomeBodySchema.transform(
  stripNextRoundForNonAdvanced,
);

export type CreateOutcomeBody = z.infer<typeof createOutcomeBodySchema>;
export type UpdateOutcomeBody = z.infer<typeof updateOutcomeBodySchema>;

/* ──────────────────────────────────────────────────────────── */
/*                              Reads                            */
/* ──────────────────────────────────────────────────────────── */

/**
 * Fetch the outcome for a session. Pinned to the session_id (NOT
 * to a user) — the API layer is responsible for proving the user
 * owns the session before calling this. Returns null when no
 * outcome has been recorded yet.
 */
export async function getOutcomeForSession(
  sessionId: string,
): Promise<SessionOutcome | null> {
  const [row] = await db
    .select()
    .from(schema.sessionOutcomes)
    .where(eq(schema.sessionOutcomes.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/* ──────────────────────────────────────────────────────────── */
/*                             Writes                            */
/* ──────────────────────────────────────────────────────────── */

export class OutcomeAlreadyExistsError extends Error {
  constructor(sessionId: string) {
    super(`Outcome already exists for session ${sessionId}`);
    this.name = "OutcomeAlreadyExistsError";
  }
}

export class OutcomeNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`No outcome exists for session ${sessionId}`);
    this.name = "OutcomeNotFoundError";
  }
}

/**
 * Walk the error chain looking for a Postgres unique-violation
 * (23505). Mirrors the `isUniqueViolation` helper in
 * `lib/compliance/export.ts` — we don't share a single helper
 * because the export module is pulled into storage-bound code paths
 * we don't want to drag into the request/response surface here.
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur != null; i++) {
    if (typeof cur === "object" && cur !== null && "code" in cur) {
      if ((cur as { code?: unknown }).code === "23505") return true;
    }
    if (typeof cur === "object" && cur !== null && "cause" in cur) {
      cur = (cur as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

interface WriteAuditCtx {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Insert a new outcome. Throws `OutcomeAlreadyExistsError` if one
 * already exists for the session — the unique index on `session_id`
 * makes this race-safe even when two POSTs land at exactly the
 * same time.
 *
 * The route handler MUST have already verified:
 *   1. The user is signed in.
 *   2. The session belongs to the user.
 *   3. The session state is `complete` (no recording an outcome
 *      for an unanalyzed session).
 *
 * Side effect: writes one `outcome.recorded` audit log entry inside
 * the same transaction.
 */
export async function createOutcome(args: {
  sessionId: string;
  body: CreateOutcomeBody;
  audit: WriteAuditCtx;
}): Promise<SessionOutcome> {
  return db.transaction(async (tx) => {
    let inserted: SessionOutcome;
    try {
      const [row] = await tx
        .insert(schema.sessionOutcomes)
        .values({
          sessionId: args.sessionId,
          outcomeType: args.body.outcome_type,
          outcomeReceivedAt: args.body.outcome_received_at
            ? new Date(args.body.outcome_received_at)
            : null,
          nextRoundType: args.body.next_round_type ?? null,
          feedbackReceived: args.body.feedback_received ?? null,
          reflectionNotes: args.body.reflection_notes ?? null,
          wouldChange: args.body.would_change ?? null,
          askedForFeedback: args.body.asked_for_feedback ?? false,
        })
        .returning();
      if (!row) {
        throw new Error(
          `createOutcome: insert returned no row for session ${args.sessionId}`,
        );
      }
      inserted = row;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new OutcomeAlreadyExistsError(args.sessionId);
      }
      throw err;
    }

    await tx.insert(schema.auditLog).values({
      userId: args.audit.userId,
      eventType: OUTCOME_AUDIT_EVENTS.recorded,
      eventData: {
        sessionId: args.sessionId,
        outcomeType: inserted.outcomeType,
        // Booleans only — the actual text is sensitive and stays
        // out of the audit log on purpose.
        hasFeedbackReceived: inserted.feedbackReceived !== null,
        hasReflectionNotes: inserted.reflectionNotes !== null,
        hasWouldChange: inserted.wouldChange !== null,
        hasOutcomeReceivedAt: inserted.outcomeReceivedAt !== null,
      },
      ipAddress: args.audit.ipAddress ?? null,
      userAgent: args.audit.userAgent ?? null,
    });

    return inserted;
  });
}

/**
 * Patch an existing outcome. Only the fields supplied in the body
 * are touched; everything else stays as-is. Throws
 * `OutcomeNotFoundError` if no row exists.
 *
 * The handler MUST verify session ownership + `complete` state
 * before calling.
 */
export async function updateOutcome(args: {
  sessionId: string;
  body: UpdateOutcomeBody;
  audit: WriteAuditCtx;
}): Promise<SessionOutcome> {
  return db.transaction(async (tx) => {
    // Lock the row so a concurrent PATCH/DELETE serializes. Cheap
    // — exactly one row matches by construction (unique index on
    // session_id).
    const [existing] = await tx
      .select()
      .from(schema.sessionOutcomes)
      .where(eq(schema.sessionOutcomes.sessionId, args.sessionId))
      .for("update")
      .limit(1);

    if (!existing) {
      throw new OutcomeNotFoundError(args.sessionId);
    }

    const updates: Partial<SessionOutcome> = {
      updatedAt: new Date(),
    };
    if (args.body.outcome_type !== undefined) {
      updates.outcomeType = args.body.outcome_type;
    }
    if (args.body.outcome_received_at !== undefined) {
      updates.outcomeReceivedAt = args.body.outcome_received_at
        ? new Date(args.body.outcome_received_at)
        : null;
    }
    if (args.body.next_round_type !== undefined) {
      updates.nextRoundType = args.body.next_round_type ?? null;
    }
    if (args.body.feedback_received !== undefined) {
      updates.feedbackReceived = args.body.feedback_received ?? null;
    }
    if (args.body.reflection_notes !== undefined) {
      updates.reflectionNotes = args.body.reflection_notes ?? null;
    }
    if (args.body.would_change !== undefined) {
      updates.wouldChange = args.body.would_change ?? null;
    }
    if (args.body.asked_for_feedback !== undefined) {
      updates.askedForFeedback = args.body.asked_for_feedback;
    }

    // Cross-field consistency: `next_round_type` only makes sense
    // when the EFFECTIVE outcome type (post-update) is
    // `advanced_to_next_round`. The Zod transform already strips
    // it when the request body is self-inconsistent, but it can't
    // see the persisted row — a PATCH like `{ next_round_type: "X" }`
    // against an existing `rejected` outcome would otherwise leak
    // through and produce a contradictory row. Force null here so
    // the DB is always self-consistent.
    const effectiveOutcomeType =
      (updates.outcomeType as OutcomeType | undefined) ?? existing.outcomeType;
    if (effectiveOutcomeType !== "advanced_to_next_round") {
      updates.nextRoundType = null;
    }

    const [updated] = await tx
      .update(schema.sessionOutcomes)
      .set(updates)
      .where(eq(schema.sessionOutcomes.sessionId, args.sessionId))
      .returning();
    if (!updated) {
      throw new OutcomeNotFoundError(args.sessionId);
    }

    await tx.insert(schema.auditLog).values({
      userId: args.audit.userId,
      eventType: OUTCOME_AUDIT_EVENTS.updated,
      eventData: {
        sessionId: args.sessionId,
        outcomeType: updated.outcomeType,
        // Which keys were touched on this PATCH. Useful for forensics
        // ("the user changed their reflection notes 5 times in a
        // week") without leaking the text.
        keysUpdated: Object.keys(args.body).filter(
          (k) =>
            (args.body as Record<string, unknown>)[k] !== undefined,
        ),
      },
      ipAddress: args.audit.ipAddress ?? null,
      userAgent: args.audit.userAgent ?? null,
    });

    return updated;
  });
}

/**
 * Delete the outcome for a session. Idempotent: returns
 * `{ deleted: false }` if no outcome was present (the API
 * surfaces this as a 404). Wrapped in a transaction so the
 * audit log entry only lands when the row actually went away.
 */
export async function deleteOutcome(args: {
  sessionId: string;
  audit: WriteAuditCtx;
}): Promise<{ deleted: boolean; previousOutcomeType?: OutcomeType }> {
  return db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(schema.sessionOutcomes)
      .where(eq(schema.sessionOutcomes.sessionId, args.sessionId))
      .returning({
        outcomeType: schema.sessionOutcomes.outcomeType,
      });

    if (!removed) {
      return { deleted: false };
    }

    await tx.insert(schema.auditLog).values({
      userId: args.audit.userId,
      eventType: OUTCOME_AUDIT_EVENTS.deleted,
      eventData: {
        sessionId: args.sessionId,
        previousOutcomeType: removed.outcomeType,
      },
      ipAddress: args.audit.ipAddress ?? null,
      userAgent: args.audit.userAgent ?? null,
    });

    return {
      deleted: true,
      previousOutcomeType: removed.outcomeType as OutcomeType,
    };
  });
}

/* ──────────────────────────────────────────────────────────── */
/*                       Reminder job helpers                    */
/* ──────────────────────────────────────────────────────────── */

export interface ReminderCandidate {
  sessionId: string;
  userId: string;
  email: string;
  companyName: string;
  roleTitle: string;
  sessionCreatedAt: Date;
}

/**
 * Sessions eligible for the "did you ever record an outcome?"
 * email. Eligibility:
 *
 *   - state = 'complete' (the user has seen the report).
 *   - created_at < now() - 14 days (give them time to actually
 *     hear back from the company).
 *   - no `session_outcomes` row exists for this session.
 *   - the user has email_verified set (we don't email
 *     unverified addresses; spec carryover from the rest of
 *     the email surface).
 *   - the user is NOT pending deletion (`deleted_at IS NULL`).
 *   - we haven't already written `outcome.reminder_sent` for
 *     this session_id (looked up via the audit log; see the
 *     inner WHERE NOT EXISTS clause). Audit log rows survive
 *     even when the user record is anonymized via FK SET NULL,
 *     so the dedupe holds across user-account changes.
 *
 * Limited to a daily batch size — the cron iterates serially so
 * one bad row doesn't stall the rest. The default 200 / day is
 * generous: at steady state we expect a small fraction of
 * `complete` sessions to age past 14 days without an outcome,
 * because most users record promptly.
 */
export async function findOutcomeReminderCandidates(args?: {
  now?: Date;
  ageDays?: number;
  limit?: number;
}): Promise<ReminderCandidate[]> {
  const now = args?.now ?? new Date();
  const ageDays = args?.ageDays ?? 14;
  const limit = Math.max(1, Math.min(500, args?.limit ?? 200));
  const cutoff = new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000);

  // Subquery: sessions for which we've already sent a reminder.
  // We compare `event_data->>'sessionId'` because the audit log
  // is keyed on the user, not the session — so the JSON path
  // extraction is the cheapest reliable check. Audit log volume
  // is small enough that a covering scan over `event_type =
  // 'outcome.reminder_sent'` rows is fine; if it ever grows we
  // can add a partial index on (event_type, (event_data->>'sessionId')).
  const alreadyReminded = sql`
    SELECT 1 FROM ${schema.auditLog}
    WHERE ${schema.auditLog.eventType} = ${OUTCOME_AUDIT_EVENTS.reminderSent}
      AND ${schema.auditLog.eventData}->>'sessionId' = ${schema.interviewSessions.id}::text
  `;

  // Outer query: complete sessions older than the cutoff that
  // (a) have no outcome and (b) haven't been reminded.
  const rows = await db
    .select({
      sessionId: schema.interviewSessions.id,
      userId: schema.interviewSessions.userId,
      email: schema.users.email,
      emailVerified: schema.users.emailVerified,
      userDeletedAt: schema.users.deletedAt,
      companyName: schema.interviewSessions.companyName,
      roleTitle: schema.interviewSessions.roleTitle,
      sessionCreatedAt: schema.interviewSessions.createdAt,
      sessionDeletedAt: schema.interviewSessions.deletedAt,
      outcomeId: schema.sessionOutcomes.id,
    })
    .from(schema.interviewSessions)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.interviewSessions.userId),
    )
    .leftJoin(
      schema.sessionOutcomes,
      eq(
        schema.sessionOutcomes.sessionId,
        schema.interviewSessions.id,
      ),
    )
    .where(
      and(
        eq(schema.interviewSessions.state, "complete"),
        isNull(schema.interviewSessions.deletedAt),
        lt(schema.interviewSessions.createdAt, cutoff),
        isNull(schema.sessionOutcomes.id),
        isNull(schema.users.deletedAt),
        isNotNull(schema.users.emailVerified),
        sql`NOT EXISTS (${alreadyReminded})`,
      ),
    )
    .orderBy(desc(schema.interviewSessions.createdAt))
    .limit(limit);

  // Defensive narrowing: the SQL guarantees these are non-null,
  // but Drizzle can't prove it through the join. The cast keeps
  // the public type clean.
  return rows
    .filter(
      (r): r is typeof r & { sessionDeletedAt: null; userDeletedAt: null } =>
        r.outcomeId === null &&
        r.email !== null &&
        r.userDeletedAt === null,
    )
    .map((r) => ({
      sessionId: r.sessionId,
      userId: r.userId,
      email: r.email,
      companyName: r.companyName,
      roleTitle: r.roleTitle,
      sessionCreatedAt: r.sessionCreatedAt,
    }));
}

/**
 * Record that we've sent the reminder. The reminder job MUST call
 * this exactly once per session per email send so the dedupe
 * check in `findOutcomeReminderCandidates` works.
 *
 * `dispatched` flips to false when the email layer falls back to
 * the dev-mode console log (Resend not configured). We still
 * write the audit row in that case so a dev-loop doesn't keep
 * "sending" the same reminder, AND we surface the boolean for
 * test assertions and ops dashboards.
 */
export async function recordOutcomeReminderSent(args: {
  sessionId: string;
  userId: string;
  email: string;
  dispatched: boolean;
  resendMessageId?: string;
}): Promise<void> {
  await db.insert(schema.auditLog).values({
    userId: args.userId,
    eventType: OUTCOME_AUDIT_EVENTS.reminderSent,
    eventData: {
      sessionId: args.sessionId,
      // Email is already on the user row but we duplicate here so
      // a forensic lookup (after the user is anonymized) still
      // shows where the reminder went.
      email: args.email,
      dispatched: args.dispatched,
      resendMessageId: args.resendMessageId ?? null,
    },
  });
}
