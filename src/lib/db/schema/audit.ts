import {
  bigserial,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users";

/**
 * Per-user heuristics computed off historical interviews (e.g. "you
 * over-use the word 'basically'", "your average pace is 165 wpm"). The
 * row is owned by the user — single PK, no surrogate id — because we
 * always overwrite, never accumulate.
 */
export const userPatterns = pgTable("user_patterns", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),

  patternsJson: jsonb("patterns_json").notNull(),
  computedFromSessionCount: integer("computed_from_session_count")
    .notNull()
    .default(0),
  lastComputedAt: timestamp("last_computed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Append-only audit trail for security/compliance review.
 *
 * `user_id` is nullable + `onDelete: "set null"` so:
 *   1. Pre-auth events (failed login, signup attempt) can be logged
 *      without a user.
 *   2. A user deletion never wipes audit history — we keep the events,
 *      just unlinked. The legally-required attribution lives in
 *      `event_data` (e.g. previous email, ip), which the compliance
 *      retention job redacts on its own schedule.
 *
 * `inet` for ip_address handles both IPv4 and IPv6 natively.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),

    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    eventType: text("event_type").notNull(),
    eventData: jsonb("event_data").notNull(),

    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Admin Ops dashboard reads (`active_users` distinct count over
    // a day, `admin_page_viewed` review surface, `admin_action.*`
    // forensic lookup). Most reads pin a specific event_type and
    // page newest-first, so a composite on
    // (event_type, created_at DESC) covers them without a sort.
    index("audit_log_event_type_created_idx").on(
      table.eventType,
      table.createdAt.desc(),
    ),
  ],
);

/**
 * Free-form admin notes attached to a user, surfaced on the
 * `/admin/users/[id]` detail page. One row per note (newest-first
 * in the UI); editing is intentionally not supported — the founder
 * deletes the bad note and writes a new one, which keeps the audit
 * story simple ("note created" and "note deleted" are both
 * captured in `audit_log`).
 *
 * `admin_id` is `onDelete: "no action"` because an admin row being
 * removed should not silently lose the attribution on past notes;
 * if a former admin is deleted, the cascade is a deliberate ops
 * action, not a behavior we want defaulting to "drop the audit
 * trail".
 */
export const adminNotes = pgTable(
  "admin_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /**
     * The admin who wrote the note. Not nullable — a note without
     * an author has no forensic value. ON DELETE NO ACTION (the
     * Drizzle default for FK without `onDelete`): a delete of the
     * admin row is refused at the DB layer until notes are
     * reassigned or removed manually. Until we have multiple
     * admins this is effectively unreachable.
     */
    adminId: uuid("admin_id")
      .notNull()
      .references(() => users.id),

    note: text("note").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Detail-page list: newest-first by user.
    index("admin_notes_user_created_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
  ],
);

export type UserPatterns = typeof userPatterns.$inferSelect;
export type NewUserPatterns = typeof userPatterns.$inferInsert;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type AdminNote = typeof adminNotes.$inferSelect;
export type NewAdminNote = typeof adminNotes.$inferInsert;
