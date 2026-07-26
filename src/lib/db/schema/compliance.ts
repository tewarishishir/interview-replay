import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";

import { users } from "./users";

/**
 * Compliance / regulatory tables. These are intentionally separate
 * from the domain schema so a future "compliance archive" backup
 * (which has different retention rules from the rest of the DB) can
 * target this file's tables in isolation.
 */

/**
 * Lifecycle of a GDPR data-export request:
 *   - `pending`   : row inserted, background job queued.
 *   - `building`  : worker started collecting + zipping data.
 *   - `ready`     : ZIP uploaded to storage, signed URL emailed.
 *   - `expired`   : the 7-day download window passed; a daily cron
 *                   reaps the file. The row itself
 *                   stays for auditability.
 *   - `failed`    : worker exhausted retries. The retry endpoint
 *                   creates a *new* row instead of mutating this
 *                   one — exports are immutable by design.
 */
export const dataExportStatus = pgEnum("data_export_status", [
  "pending",
  "building",
  "ready",
  "expired",
  "failed",
]);
export const dataExportStatusSchema = z.enum(dataExportStatus.enumValues);
export type DataExportStatus = z.infer<typeof dataExportStatusSchema>;

/**
 * One row per "export my data" request. We keep a row even after
 * the stored file expires so the audit trail can show every time the
 * user exercised their data-portability right under GDPR Art. 20.
 *
 * `s3Key` is the canonical pointer to the stored file (a daily cron
 * reaps it 7 days post-creation). The signed download URL is NEVER
 * persisted: it's a credential, not a key, and we re-mint it for
 * each download to keep the credential window narrow.
 */
export const dataExports = pgTable(
  "data_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    status: dataExportStatus("status").notNull().default("pending"),

    s3Key: text("s3_key"),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),

    /**
     * 7-day TTL from the spec. Set when the worker uploads the ZIP;
     * a daily cron flips status to `expired` and (defense-in-depth)
     * deletes the stored file regardless of whether the cleanup
     * policy already did.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    /**
     * Captured if the export worker fails after retries. We surface
     * this in the dashboard so the user can re-request without
     * support contact.
     */
    error: text("error"),

    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    // Dashboard "my exports" listing.
    index("data_exports_user_requested_idx").on(
      table.userId,
      table.requestedAt.desc(),
    ),
    // Cron: select status='ready' WHERE expires_at < now().
    index("data_exports_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'ready'`),
    // At most one in-flight export per user. The application tries
    // to short-circuit this at the API layer (`findInFlightExport`),
    // but a partial unique index is the only thing that survives
    // races between two concurrent POST /api/me/export calls. The
    // INSERT in `enqueueExportRow` catches the unique violation
    // and looks up the existing row.
    uniqueIndex("data_exports_user_in_flight_uniq")
      .on(table.userId)
      .where(sql`${table.status} IN ('pending', 'building')`),
  ],
);

export type DataExport = typeof dataExports.$inferSelect;
export type NewDataExport = typeof dataExports.$inferInsert;
