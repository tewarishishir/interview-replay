import "server-only";

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import JSZip from "jszip";

import { db, schema } from "@/lib/db";
import { features } from "@/lib/env";
import { StorageNotConfiguredError } from "@/lib/storage";
import { writeFile } from "@/lib/storage/write";
import { readFile } from "@/lib/storage/read";
import { buildFileUrl } from "@/lib/storage/signed-url";

import { EXPORT_TTL_MS, EXPORT_TTL_SECONDS } from "./constants";

/**
 * Re-export to give callers a single import surface.
 */
export const EXPORT_DOWNLOAD_TTL_SECONDS = EXPORT_TTL_SECONDS;

/**
 * Storage key shape for export ZIPs.
 *   exports/{userId}/{exportId}.zip
 *
 * Mirrors the audio key layout (prefix + userId + uuid).
 */
export function buildExportKey(args: {
  userId: string;
  exportId: string;
}): string {
  return `exports/${args.userId}/${args.exportId}.zip`;
}

/**
 * Pre-flight check: refuse to enqueue a new export if the user has
 * one that's already `pending` or `building` — exports are
 * expensive (whole-account ZIP) and a double-click should not
 * fan out to two workers. Returns the existing row so the API can
 * 200 with "we're working on it" instead of 409-ing.
 *
 * The status filter is pushed into the SQL `WHERE` so this is a
 * covered read on the `data_exports_user_in_flight_uniq` partial
 * unique index — at most one row matches by construction.
 */
export async function findInFlightExport(
  userId: string,
): Promise<{ id: string; status: "pending" | "building" } | null> {
  const rows = await db
    .select({
      id: schema.dataExports.id,
      status: schema.dataExports.status,
    })
    .from(schema.dataExports)
    .where(
      and(
        eq(schema.dataExports.userId, userId),
        inArray(schema.dataExports.status, ["pending", "building"]),
      ),
    )
    .limit(1);

  const r = rows[0];
  if (!r) return null;
  // Narrow `status` for the caller — the filter above guarantees it.
  if (r.status !== "pending" && r.status !== "building") return null;
  return { id: r.id, status: r.status };
}

/**
 * Insert a new `pending` row for the user.
 *
 * Race-safe via the partial unique index on `(user_id) WHERE status
 * IN ('pending', 'building')`: two concurrent POST /api/me/export
 * calls cannot both INSERT — the second one trips the unique
 * violation, and we recover by looking up the existing in-flight
 * row and returning it with `existed: true`. The job runner is
 * idempotent on the row id, so the worker only does one round-trip
 * regardless.
 */
export async function enqueueExportRow(args: {
  userId: string;
}): Promise<{ id: string; existed: boolean }> {
  try {
    const [row] = await db
      .insert(schema.dataExports)
      .values({
        userId: args.userId,
        status: "pending",
      })
      .returning({ id: schema.dataExports.id });

    if (!row) {
      throw new Error(
        `enqueueExportRow: insert returned no row for user ${args.userId}`,
      );
    }
    return { id: row.id, existed: false };
  } catch (err) {
    // 23505 = unique_violation. Caused by the partial unique index
    // when a concurrent in-flight row already exists. We re-read the
    // current in-flight row and return it; if it's vanished by now
    // (raced with the worker that flipped status to ready/failed),
    // bubble out — the API layer treats that as a transient and the
    // user can retry.
    if (isUniqueViolation(err)) {
      const existing = await findInFlightExport(args.userId);
      if (existing) return { id: existing.id, existed: true };
    }
    throw err;
  }
}

/**
 * Walk the error chain (top-level + `.cause`) looking for a Postgres
 * `code` of 23505 (unique_violation). Drizzle normally surfaces the
 * pg error as the cause; we also check the top level so a future
 * driver swap doesn't silently break this branch.
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  // Bound the walk so a self-referential `cause` chain can't loop.
  for (let i = 0; i < 5 && cur != null; i++) {
    if (typeof cur === "object" && cur !== null && "code" in cur) {
      const code = (cur as { code?: unknown }).code;
      if (code === "23505") return true;
    }
    if (typeof cur === "object" && cur !== null && "cause" in cur) {
      cur = (cur as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

/**
 * Latest non-expired export the user can still download. Used by
 * the account page to render the "your last export" link.
 */
export async function getLatestReadyExport(
  userId: string,
  now: Date = new Date(),
): Promise<
  | {
      id: string;
      s3Key: string;
      expiresAt: Date;
      fileSizeBytes: number | null;
      completedAt: Date | null;
    }
  | null
> {
  const rows = await db
    .select({
      id: schema.dataExports.id,
      s3Key: schema.dataExports.s3Key,
      expiresAt: schema.dataExports.expiresAt,
      fileSizeBytes: schema.dataExports.fileSizeBytes,
      completedAt: schema.dataExports.completedAt,
    })
    .from(schema.dataExports)
    .where(
      and(
        eq(schema.dataExports.userId, userId),
        eq(schema.dataExports.status, "ready"),
      ),
    );

  const fresh = rows
    .filter(
      (r): r is {
        id: string;
        s3Key: string;
        expiresAt: Date;
        fileSizeBytes: number | null;
        completedAt: Date | null;
      } =>
        r.s3Key !== null &&
        r.expiresAt !== null &&
        r.expiresAt.getTime() > now.getTime(),
    )
    .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());

  return fresh[0] ?? null;
}

/**
 * Mint a download URL with the same lifetime as the row's TTL.
 * Doing it on demand (instead of persisting one long-lived URL)
 * means we never persist a long-lived URL, AND it caps the
 * credential window at (download time + TTL) rather than
 * (request time + TTL).
 */
export async function presignExportDownload(args: {
  s3Key: string;
  ttlSeconds?: number;
}): Promise<{ url: string; expiresAt: Date }> {
  const ttl = args.ttlSeconds ?? EXPORT_DOWNLOAD_TTL_SECONDS;
  const url = buildFileUrl(args.s3Key, ttl);
  return { url, expiresAt: new Date(Date.now() + ttl * 1000) };
}

export interface UserDataDump {
  profile: unknown;
  sessions: unknown[];
  transcripts: unknown[];
  artifacts: unknown[];
  reports: unknown[];
  audioFiles: unknown[];
  outcomes: unknown[];
  /**
   * Practice-Rebuild drafts the user owns, including discarded
   * ones still inside the 30-day retention window. The text fields
   * (question, headline, STAR scaffold) are exported as-is for
   * portability — the export endpoint is gated by reauthentication,
   * so plain text in the ZIP is the right level of access.
   */
  rebuilds: unknown[];
  creditPurchases: unknown[];
  creditTransactions: unknown[];
  exportedAt: string;
}

/**
 * Read every row owned by the user (or descendant of one of their
 * sessions). We deliberately re-include soft-deleted sessions and
 * any audio_files rows that are still around — the spec is "give
 * the user everything we have", not "give them only what we'd
 * normally show in the UI".
 *
 * Audio BLOBS are NOT included; the spec is explicit that audio is
 * deleted within 60 seconds of transcription, so by the time an
 * export runs there's nothing in storage to ship. We do include the
 * audio_files METADATA so the user can see when a recording
 * existed and when it was deleted.
 */
export async function collectUserDataForExport(
  userId: string,
): Promise<UserDataDump> {
  const [profile] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      emailVerified: schema.users.emailVerified,
      creditBalance: schema.users.creditBalance,
      freeCreditUsed: schema.users.freeCreditUsed,
      // Internal sub-credit accumulator for rebuild critiques. The user
      // has a right to see it under "give them everything we have"; it
      // also makes a charge dispute easier to walk through with them
      // (the value 0..3 shows how close they were to the next 1-credit
      // rollover at export time).
      rebuildCritiqueUnits: schema.users.rebuildCritiqueUnits,
      signupCountryCode: schema.users.signupCountryCode,
      createdAt: schema.users.createdAt,
      updatedAt: schema.users.updatedAt,
      deletedAt: schema.users.deletedAt,
      deletionRequestedAt: schema.users.deletionRequestedAt,
      termsAcceptedAt: schema.users.termsAcceptedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!profile) {
    throw new Error(
      `collectUserDataForExport: user ${userId} not found`,
    );
  }

  const sessions = await db
    .select()
    .from(schema.interviewSessions)
    .where(eq(schema.interviewSessions.userId, userId));
  const sessionIds = sessions.map((s) => s.id);

  const transcripts =
    sessionIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.transcripts)
          .where(
            inArrayOrNeverMatches(schema.transcripts.sessionId, sessionIds),
          );

  const artifacts =
    sessionIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.artifacts)
          .where(
            inArrayOrNeverMatches(schema.artifacts.sessionId, sessionIds),
          );

  const reports =
    sessionIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.reports)
          .where(inArrayOrNeverMatches(schema.reports.sessionId, sessionIds));

  const audioFiles =
    sessionIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.audioFiles)
          .where(
            inArrayOrNeverMatches(schema.audioFiles.sessionId, sessionIds),
          );

  const outcomes =
    sessionIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.sessionOutcomes)
          .where(
            inArrayOrNeverMatches(
              schema.sessionOutcomes.sessionId,
              sessionIds,
            ),
          );

  const creditPurchases = await db
    .select()
    .from(schema.creditPurchases)
    .where(eq(schema.creditPurchases.userId, userId));

  const creditTransactions = await db
    .select()
    .from(schema.creditTransactions)
    .where(eq(schema.creditTransactions.userId, userId));

  // Practice Rebuild drafts. Includes every status (in_progress,
  // critiqued, saved_to_bank, discarded) so the export is a true
  // dump of what we hold for the user — even rebuilds inside the
  // 30-day discard retention window are surfaced before they get
  // hard-purged.
  const rebuilds = await db
    .select()
    .from(schema.storyRebuilds)
    .where(eq(schema.storyRebuilds.userId, userId));

  return {
    profile,
    sessions,
    transcripts,
    artifacts,
    reports,
    audioFiles,
    outcomes,
    rebuilds,
    creditPurchases,
    creditTransactions,
    exportedAt: new Date().toISOString(),
  };
}

/**
 * Helper: drizzle's `inArray` throws on an empty list. The export
 * collector never actually calls this with `[]` (the caller short-
 * circuits) but the helper exists so the call sites read in plain
 * English and a future refactor can't reintroduce the empty-list
 * crash.
 */
function inArrayOrNeverMatches<T extends string>(
  column: PgColumn,
  values: readonly T[],
): SQL {
  if (values.length === 0) {
    // Predicate that is never true. We use raw SQL `false` rather
    // than `eq(col, null)` because the latter is never actually
    // false — `col = NULL` evaluates to NULL, not false, but the
    // semantic intent is clearer this way.
    return sql`false`;
  }
  return inArray(column, [...values]);
}

/**
 * Hard cap on the compressed export ZIP size. The dump JSON is
 * pretty-printed (one row per indented line) so it expands ~5x vs
 * the raw row payload, but DEFLATE squeezes it back down — even a
 * power user with thousands of sessions stays well under 10 MB.
 *
 * 100 MB is the line where we're protecting the worker against:
 *   - a runaway transcript (e.g. a stuck recording that never
 *     auto-stopped),
 *   - a cron-bug-induced row explosion (artifacts/transcripts that
 *     duplicated themselves on retry),
 *   - a deliberate fill-the-DB attempt by a malicious user.
 *
 * `markExportFailed` flips the row so the user sees a clear UI
 * error ("export too large — please contact support") instead of
 * burning bandwidth on a half-uploaded ZIP they can't download
 * in 7 days anyway.
 */
export const EXPORT_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB

export class ExportTooLargeError extends Error {
  readonly bytes: number;
  readonly limit: number;
  constructor(bytes: number, limit: number = EXPORT_MAX_BYTES) {
    super(
      `Export ZIP would be ${bytes} bytes (limit ${limit}). The export was aborted before upload.`,
    );
    this.name = "ExportTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * Build the ZIP body. One JSON file per category; pretty-printed so
 * a user opening it in TextEdit / Notepad sees structured content
 * instead of a single line. Throws `ExportTooLargeError` if the
 * compressed size exceeds the cap — checked AFTER zip generation so
 * the cap reflects what storage would actually receive.
 *
 * `maxBytes` is parameterized for tests; production code uses the
 * default (`EXPORT_MAX_BYTES`).
 */
export async function buildExportZip(
  dump: UserDataDump,
  opts: { maxBytes?: number } = {},
): Promise<Uint8Array> {
  const maxBytes = opts.maxBytes ?? EXPORT_MAX_BYTES;
  const zip = new JSZip();

  const write = (name: string, body: unknown): void => {
    zip.file(name, JSON.stringify(body, null, 2));
  };

  write("profile.json", dump.profile);
  write("sessions.json", dump.sessions);
  write("transcripts.json", dump.transcripts);
  write("artifacts.json", dump.artifacts);
  write("reports.json", dump.reports);
  write("audio_files.json", dump.audioFiles);
  write("outcomes.json", dump.outcomes);
  write("rebuilds.json", dump.rebuilds);
  write("credit_purchases.json", dump.creditPurchases);
  write("credit_transactions.json", dump.creditTransactions);

  zip.file(
    "README.txt",
    [
      "InterviewReplay data export",
      "==================",
      "",
      `Exported at: ${dump.exportedAt}`,
      "",
      "This archive contains every row InterviewReplay stores about your account",
      "in JSON. Audio recordings are NOT included: per our privacy policy",
      "we delete the original audio within 60 seconds of transcription.",
      "The audio_files.json file shows the metadata (timestamps, sizes)",
      "of recordings we processed.",
      "",
      "Files",
      "-----",
      "  profile.json              account-level data",
      "  sessions.json             every interview you started",
      "  transcripts.json          transcripts of recorded sessions",
      "  artifacts.json            notes / code / images you added",
      "  reports.json              AI feedback reports",
      "  audio_files.json          metadata about deleted recordings",
      "  outcomes.json             interview outcomes you recorded",
      "  rebuilds.json             Practice Rebuild drafts and AI critiques",
      "  credit_purchases.json     Stripe purchase history",
      "  credit_transactions.json  credit ledger (signup bonus, charges, refunds)",
      "",
      "Questions: privacy@example.com",
    ].join("\n"),
  );

  const body = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });

  if (body.byteLength > maxBytes) {
    throw new ExportTooLargeError(body.byteLength, maxBytes);
  }

  return body;
}

export async function uploadExportZip(args: {
  s3Key: string;
  body: Uint8Array;
}): Promise<{ size: number }> {
  await writeFile(args.s3Key, Buffer.from(args.body));
  return { size: args.body.byteLength };
}

/**
 * Mark the row `ready` and stamp the TTL. Returns the row so the
 * caller can compose the email + audit log without a re-read.
 */
export async function markExportReady(args: {
  exportId: string;
  s3Key: string;
  fileSizeBytes: number;
  now?: Date;
}): Promise<{ expiresAt: Date }> {
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + EXPORT_TTL_MS);

  await db
    .update(schema.dataExports)
    .set({
      status: "ready",
      s3Key: args.s3Key,
      fileSizeBytes: args.fileSizeBytes,
      completedAt: now,
      expiresAt,
    })
    .where(eq(schema.dataExports.id, args.exportId));

  return { expiresAt };
}

export async function markExportBuilding(exportId: string): Promise<void> {
  await db
    .update(schema.dataExports)
    .set({ status: "building" })
    .where(eq(schema.dataExports.id, exportId));
}

export async function markExportFailed(args: {
  exportId: string;
  error: string;
}): Promise<void> {
  await db
    .update(schema.dataExports)
    .set({
      status: "failed",
      error: args.error,
      completedAt: new Date(),
    })
    .where(eq(schema.dataExports.id, args.exportId));
}

export interface ExpiredExportRow {
  id: string;
  s3Key: string | null;
  userId: string;
}

/**
 * Find ready-but-past-TTL exports for the daily expiry sweep.
 */
export async function findExpiredExports(args?: {
  now?: Date;
  limit?: number;
}): Promise<ExpiredExportRow[]> {
  const now = args?.now ?? new Date();
  const limit = Math.max(1, Math.min(500, args?.limit ?? 100));

  const rows = await db
    .select({
      id: schema.dataExports.id,
      s3Key: schema.dataExports.s3Key,
      userId: schema.dataExports.userId,
      expiresAt: schema.dataExports.expiresAt,
      status: schema.dataExports.status,
    })
    .from(schema.dataExports)
    .where(eq(schema.dataExports.status, "ready"))
    .limit(limit);

  return rows
    .filter(
      (r) => r.expiresAt !== null && r.expiresAt.getTime() < now.getTime(),
    )
    .map((r) => ({ id: r.id, s3Key: r.s3Key, userId: r.userId }));
}

export async function markExportExpired(exportId: string): Promise<void> {
  await db
    .update(schema.dataExports)
    .set({ status: "expired" })
    .where(eq(schema.dataExports.id, exportId));
}

export { StorageNotConfiguredError };
export const __isFeatureEnabled = (): boolean => features.audioStorage;
