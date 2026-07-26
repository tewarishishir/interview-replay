import "server-only";

import { and, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

import {
  ACCOUNT_DELETION_GRACE_DAYS,
  ACCOUNT_DELETION_GRACE_MS,
} from "./constants";

/**
 * Pure (no auth, no HTTP) helpers for the account deletion
 * lifecycle. Tested in isolation; the API routes wrap these with
 * auth and rate-limiting, the cron wraps them with batched
 * scheduling, and the email layer wraps them with the dispatch
 * side effect.
 *
 * Three lifecycle states modeled here:
 *
 *   active    : `deleted_at IS NULL AND deletion_requested_at IS NULL`
 *   pending   : `deleted_at IS NOT NULL AND deletion_requested_at IS NOT NULL`
 *               within the 30-day grace window
 *   gone      : `deletion_requested_at < now() - 30 days` (the cron sweeps these)
 *
 * After the cron's hard-delete pass the row simply doesn't exist.
 * Audit-log entries for the user are anonymized (FK already
 * `set null`), and credit_purchases / credit_transactions are
 * detached from the user (FK is RESTRICT, so we explicitly null
 * the `user_id` on those rows in the cron).
 */

export interface DeletionState {
  /** True iff `deleted_at` is set on the user row. */
  pending: boolean;
  /** Anchor for the grace clock. */
  requestedAt: Date | null;
  /** Wall-clock deadline for hard-delete. */
  hardDeleteAt: Date | null;
  /** Whether the grace window has already elapsed. */
  expired: boolean;
}

export function describeDeletionState(args: {
  deletedAt: Date | null;
  deletionRequestedAt: Date | null;
  now?: Date;
}): DeletionState {
  const now = args.now ?? new Date();
  const requestedAt = args.deletionRequestedAt;

  if (!requestedAt) {
    return {
      pending: Boolean(args.deletedAt),
      requestedAt: null,
      hardDeleteAt: null,
      expired: false,
    };
  }

  const hardDeleteAt = new Date(
    requestedAt.getTime() + ACCOUNT_DELETION_GRACE_MS,
  );
  return {
    pending: true,
    requestedAt,
    hardDeleteAt,
    expired: now.getTime() >= hardDeleteAt.getTime(),
  };
}

export interface InitiateDeletionResult {
  ok: true;
  hardDeleteAt: Date;
  alreadyPending: boolean;
}

/**
 * Stamp `deleted_at` and `deletion_requested_at` atomically and
 * write the audit row. Idempotent — if the user's row is already
 * pending, we leave the existing timestamps in place so the grace
 * clock isn't silently extended each time the user re-clicks the
 * button. The returned `hardDeleteAt` reflects whatever clock is
 * already running.
 */
export async function initiateAccountDeletion(args: {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<InitiateDeletionResult> {
  const now = new Date();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: schema.users.id,
        deletedAt: schema.users.deletedAt,
        deletionRequestedAt: schema.users.deletionRequestedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, args.userId))
      .limit(1);

    if (!existing) {
      // Defensive: the API layer already gates on `getActiveUserId`,
      // but if the user vanished between auth and DB write we still
      // need to behave deterministically.
      throw new Error(
        `initiateAccountDeletion: user ${args.userId} not found`,
      );
    }

    if (existing.deletionRequestedAt) {
      // Idempotent: the clock is already running. Don't reset it.
      const hardDeleteAt = new Date(
        existing.deletionRequestedAt.getTime() + ACCOUNT_DELETION_GRACE_MS,
      );
      return { ok: true as const, hardDeleteAt, alreadyPending: true };
    }

    await tx
      .update(schema.users)
      .set({
        deletedAt: now,
        deletionRequestedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.users.id, args.userId));

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "account.deletion.initiated",
      eventData: {
        graceDays: ACCOUNT_DELETION_GRACE_DAYS,
        hardDeleteAt: new Date(
          now.getTime() + ACCOUNT_DELETION_GRACE_MS,
        ).toISOString(),
      },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });

    return {
      ok: true as const,
      hardDeleteAt: new Date(now.getTime() + ACCOUNT_DELETION_GRACE_MS),
      alreadyPending: false,
    };
  });
}

export type RestoreAccountResult =
  | { ok: true; restoredAt: Date }
  | { ok: false; reason: "not_pending" | "expired" | "user_missing" };

/**
 * Cancel a pending deletion if (and only if) we're still inside the
 * grace window. Past the window, the row is in the cron's queue and
 * the API returns 410 Gone — we don't try to undo a hard-delete
 * that hasn't happened yet because we don't know what the cron is
 * about to do (it may have already started).
 *
 * Used by `POST /api/me/restore` AND by the credentials sign-in path
 * (which auto-restores when the user logs in during the grace
 * window — that's the explicit "sign back in to cancel" UX).
 */
export async function restoreAccount(args: {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<RestoreAccountResult> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - ACCOUNT_DELETION_GRACE_MS);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: schema.users.id,
        deletedAt: schema.users.deletedAt,
        deletionRequestedAt: schema.users.deletionRequestedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, args.userId))
      .limit(1);

    if (!existing) {
      return { ok: false as const, reason: "user_missing" as const };
    }
    if (!existing.deletionRequestedAt || !existing.deletedAt) {
      return { ok: false as const, reason: "not_pending" as const };
    }
    if (existing.deletionRequestedAt.getTime() < cutoff.getTime()) {
      // Past the 30-day window — the cron owns this row now.
      return { ok: false as const, reason: "expired" as const };
    }

    await tx
      .update(schema.users)
      .set({
        deletedAt: null,
        deletionRequestedAt: null,
        updatedAt: now,
      })
      .where(eq(schema.users.id, args.userId));

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "account.deletion.cancelled",
      eventData: {
        previouslyRequestedAt: existing.deletionRequestedAt.toISOString(),
      },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });

    return { ok: true as const, restoredAt: now };
  });
}

export interface PendingDeletionRow {
  userId: string;
  email: string;
  deletionRequestedAt: Date;
}

/**
 * Find every user whose grace window has elapsed. The cron walks
 * these one row at a time so a single bad row (cascading FK error,
 * stuck storage file) doesn't block the whole batch.
 */
export async function findExpiredDeletions(args?: {
  now?: Date;
  limit?: number;
}): Promise<PendingDeletionRow[]> {
  const now = args?.now ?? new Date();
  const cutoff = new Date(now.getTime() - ACCOUNT_DELETION_GRACE_MS);
  const limit = Math.max(1, Math.min(500, args?.limit ?? 100));

  const rows = await db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      deletionRequestedAt: schema.users.deletionRequestedAt,
    })
    .from(schema.users)
    .where(
      and(
        isNotNull(schema.users.deletionRequestedAt),
        lt(schema.users.deletionRequestedAt, cutoff),
      ),
    )
    .limit(limit);

  return rows
    .filter(
      (r): r is { userId: string; email: string; deletionRequestedAt: Date } =>
        r.deletionRequestedAt !== null,
    )
    .map((r) => ({
      userId: r.userId,
      email: r.email,
      deletionRequestedAt: r.deletionRequestedAt,
    }));
}

export interface UserHardDeleteKeys {
  /** Audio storage keys still referenced by the user's sessions. */
  audioKeys: string[];
  /** Data-export ZIP keys for the user. */
  exportKeys: string[];
}

/**
 * Snapshot of the storage keys that `hardDeleteUserRecord`'s DB cascade
 * is about to drop. The cron uses this to delete the actual storage
 * files BEFORE the cascade so a failed storage delete doesn't orphan
 * the file (the user row stays put, the next cron tick retries).
 *
 * Read-only — no locks, no writes. Best-effort snapshot.
 */
export async function collectUserHardDeleteKeys(
  userId: string,
): Promise<UserHardDeleteKeys> {
  const audioRows = await db
    .select({ s3Key: schema.audioFiles.s3Key })
    .from(schema.audioFiles)
    .innerJoin(
      schema.interviewSessions,
      eq(schema.audioFiles.sessionId, schema.interviewSessions.id),
    )
    .where(
      and(
        eq(schema.interviewSessions.userId, userId),
        isNull(schema.audioFiles.deletedAt),
      ),
    );

  const exportRows = await db
    .select({ s3Key: schema.dataExports.s3Key })
    .from(schema.dataExports)
    .where(
      and(
        eq(schema.dataExports.userId, userId),
        isNotNull(schema.dataExports.s3Key),
      ),
    );

  return {
    audioKeys: audioRows.map((r) => r.s3Key),
    exportKeys: exportRows
      .map((r) => r.s3Key)
      .filter((k): k is string => k !== null),
  };
}

export type HardDeleteAccountResult =
  | {
      ok: true;
      userId: string;
      /** Storage keys the DB rows pointed at (passed up for audit logging). */
      s3KeysAttempted: string[];
      /** Audit-log rows whose `user_id` was set NULL (anonymized count). */
      auditLogAnonymized: number;
      /** Credit-purchase rows whose `user_id` was set NULL. */
      purchasesAnonymized: number;
      /** Credit-transaction rows whose `user_id` was set NULL. */
      transactionsAnonymized: number;
    }
  | {
      ok: false;
      userId: string;
      /**
       * Why we aborted. `restored` means the user successfully
       * cancelled their deletion between the cron's `findExpired`
       * scan and our row lock — the right move is to walk away
       * quietly. `not_pending` means the row was never pending in
       * the first place (defensive guard for stale cron payloads).
       * `user_missing` means the row vanished (already deleted).
       */
      reason: "restored" | "not_pending" | "user_missing";
    };

/**
 * Pure DB side of the hard-delete pass. Locks the user row, re-checks
 * the deletion timestamp inside the transaction (defeats the
 * cron-vs-restore TOCTTOU race), then runs the cascade.
 *
 * The TOCTTOU race we're closing: `findExpiredDeletions` (in the
 * cron) reads the user's `deletion_requested_at` and decides "this
 * one is past 30 days, hard-delete it". If the user calls
 * `restoreAccount` between that read and our DB write, the cron
 * would otherwise nuke an account the user just chose to keep. We
 * use `SELECT ... FOR UPDATE` + a re-check to serialize against
 * `restoreAccount`, which runs inside its own transaction.
 *
 * Order matters here:
 *   1. SELECT ... FOR UPDATE on the user row.
 *   2. Re-check `deletion_requested_at < cutoff`. Abort if not.
 *   3. Anonymize audit_log first (FK is set-null; we keep the rows
 *      for compliance auditability).
 *   4. Anonymize credit_purchases + credit_transactions (FK is
 *      RESTRICT, so we MUST null the user_id before deleting the
 *      user — otherwise the cascade fails at the user row).
 *   5. Hard-delete the user (cascades wipe interview_sessions,
 *      transcripts, artifacts, reports, audio_files,
 *      verification_tokens, accounts, auth_sessions, user_patterns,
 *      data_exports per their FK config).
 *
 * Side effect: the CRON is responsible for the actual storage deletes
 * BEFORE calling this function (see
 * `collectUserHardDeleteKeys`) — that way a failed storage delete leaves
 * the user row intact for the next tick to retry, instead of
 * orphaning storage files.
 */
export async function hardDeleteUserRecord(args: {
  userId: string;
  /** Override for tests; defaults to `new Date()`. */
  now?: Date;
}): Promise<HardDeleteAccountResult> {
  const now = args.now ?? new Date();
  const cutoff = new Date(now.getTime() - ACCOUNT_DELETION_GRACE_MS);

  return db.transaction(async (tx) => {
    // 1. Lock the user row. Serializes against `restoreAccount` and
    //    any concurrent cron tick.
    const lockResult = await tx.execute<{
      id: string;
      deletion_requested_at: string | null;
    }>(sql`
      SELECT id, deletion_requested_at
      FROM ${schema.users}
      WHERE id = ${args.userId}
      FOR UPDATE
    `);
    const locked = lockResult.rows[0];

    if (!locked) {
      return { ok: false as const, userId: args.userId, reason: "user_missing" as const };
    }

    // 2. TOCTTOU re-check. The cron read `deletion_requested_at`
    //    moments ago; if the user restored their account in the
    //    meantime, that field is now NULL (or got pushed forward by
    //    a re-initiate). Either way, we must NOT proceed.
    if (!locked.deletion_requested_at) {
      return { ok: false as const, userId: args.userId, reason: "restored" as const };
    }
    const requestedAt = new Date(locked.deletion_requested_at);
    if (requestedAt.getTime() >= cutoff.getTime()) {
      // The grace clock isn't expired anymore — either the user
      // re-initiated (clock reset) or the cron's `findExpired` was
      // operating on stale data. Treat as not-pending so the cron
      // logs and moves on.
      return { ok: false as const, userId: args.userId, reason: "not_pending" as const };
    }

    // 3. Re-collect storage keys inside the locked transaction so the
    //    return reflects exactly what cascade is about to wipe.
    //    (The cron has already deleted the storage files via
    //    `collectUserHardDeleteKeys`; we surface the keys for the
    //    audit-log payload.)
    const audioRows = await tx
      .select({ s3Key: schema.audioFiles.s3Key })
      .from(schema.audioFiles)
      .innerJoin(
        schema.interviewSessions,
        eq(schema.audioFiles.sessionId, schema.interviewSessions.id),
      )
      .where(
        and(
          eq(schema.interviewSessions.userId, args.userId),
          isNull(schema.audioFiles.deletedAt),
        ),
      );

    const exportRows = await tx
      .select({ s3Key: schema.dataExports.s3Key })
      .from(schema.dataExports)
      .where(
        and(
          eq(schema.dataExports.userId, args.userId),
          isNotNull(schema.dataExports.s3Key),
        ),
      );

    const s3KeysAttempted = [
      ...audioRows.map((r) => r.s3Key),
      ...exportRows.map((r) => r.s3Key).filter((k): k is string => k !== null),
    ];

    // 4. Anonymize audit_log rows. The FK is `set null`, so a plain
    //    UPDATE is enough — we DON'T cascade-delete because the
    //    rows themselves stay (regulatory auditability), only the
    //    user attribution leaves.
    const anonymizedAudit = await tx
      .update(schema.auditLog)
      .set({ userId: null })
      .where(eq(schema.auditLog.userId, args.userId))
      .returning({ id: schema.auditLog.id });

    // 5. Anonymize credit history. Both tables have FK RESTRICT,
    //    so we MUST null user_id before the user delete or the
    //    cascade fails. Note: ledger entries here also drop their
    //    related_session_id link automatically when the cascade
    //    wipes interview_sessions (FK is `set null`).
    const anonymizedPurchases = await tx
      .update(schema.creditPurchases)
      .set({ userId: null })
      .where(eq(schema.creditPurchases.userId, args.userId))
      .returning({ id: schema.creditPurchases.id });

    const anonymizedTransactions = await tx
      .update(schema.creditTransactions)
      .set({ userId: null })
      .where(eq(schema.creditTransactions.userId, args.userId))
      .returning({ id: schema.creditTransactions.id });

    // 6. Hard-delete the user. Cascades take care of:
    //    interview_sessions, transcripts, artifacts, reports,
    //    audio_files, accounts, auth_sessions, user_patterns,
    //    data_exports, verification_tokens (via email match — see
    //    below).
    await tx.delete(schema.users).where(eq(schema.users.id, args.userId));

    return {
      ok: true as const,
      userId: args.userId,
      s3KeysAttempted,
      auditLogAnonymized: anonymizedAudit.length,
      purchasesAnonymized: anonymizedPurchases.length,
      transactionsAnonymized: anonymizedTransactions.length,
    };
  });
}

/**
 * Quick-check used by the credentials sign-in path: is this user
 * inside the deletion grace window? Returns the deletion timestamp
 * so the sign-in flow can auto-restore (and the UI can surface the
 * "we cancelled your scheduled deletion" toast).
 *
 * Distinct from the broader `describeDeletionState` so the sign-in
 * path doesn't have to load the full user row: this is a covered
 * read on the indexed PK.
 */
export async function getPendingDeletion(
  userId: string,
  now: Date = new Date(),
): Promise<{ deletionRequestedAt: Date } | null> {
  const cutoff = new Date(now.getTime() - ACCOUNT_DELETION_GRACE_MS);
  const [row] = await db
    .select({ deletionRequestedAt: schema.users.deletionRequestedAt })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.id, userId),
        isNotNull(schema.users.deletionRequestedAt),
        gte(schema.users.deletionRequestedAt, cutoff),
      ),
    )
    .limit(1);

  if (!row?.deletionRequestedAt) return null;
  return { deletionRequestedAt: row.deletionRequestedAt };
}
