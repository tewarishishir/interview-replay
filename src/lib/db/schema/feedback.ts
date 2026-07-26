import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { users } from "./users";

/**
 * User-submitted product feedback. Captured via the floating
 * widget rendered in every authenticated layout (`(app)`, `(admin)`).
 * A small admin queue at `/admin/feedback` lets a founder review
 * incoming entries and approve a "few good ones" for future
 * surfacing on the marketing home page as testimonials.
 *
 * Design notes:
 *
 *   - The submitter is always an authenticated user — the widget
 *     is only mounted in layouts that have a session — so
 *     `user_id` is NOT NULL with `ON DELETE CASCADE`. If the user
 *     deletes their account their feedback goes with them; for
 *     surviving testimonial use, the admin should snapshot the
 *     row's `display_name` / `display_role` at approval time into
 *     a separate testimonials table (out of scope for this
 *     iteration).
 *   - `status` is `'pending' | 'approved' | 'rejected'`, stored as
 *     TEXT + a CHECK constraint in the migration (mirroring the
 *     `outcomes.outcome_type` pattern — we want to be able to add
 *     new statuses with a single ALTER without the destructive
 *     pgEnum rewrite).
 *   - `consent_public` is the load-bearing gate: only approved
 *     entries with consent_public=true may be shown publicly. The
 *     partial index `feedback_approved_idx` enforces this query
 *     shape so the home-page testimonial fetch is cheap.
 *   - `message` text is intentionally NOT length-capped at the DB
 *     level (Postgres TEXT is unbounded). The API edge caps to
 *     2000 chars via zod so a future ratchet up/down doesn't
 *     require a migration. The widget UI mirrors the 2000-char
 *     cap with a live counter.
 *   - `page_path` is the URL the candidate was on when they
 *     opened the widget — pure metadata for understanding "where
 *     in the product does feedback come from?". Never includes
 *     query strings (the widget strips them client-side) so we
 *     don't accidentally retain UTM tokens or one-time tokens.
 */

/**
 * Allowed `status` values. Order here is the order shown in the
 * admin filter chips.
 */
export const FEEDBACK_STATUSES = ["pending", "approved", "rejected"] as const;
export const feedbackStatusSchema = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

/**
 * Rating bounds. 1-5 inclusive; values outside the range are
 * rejected at the API edge by zod AND by the DB CHECK constraint
 * (defence in depth — a future raw-SQL caller still can't insert
 * a 6).
 */
export const FEEDBACK_RATING_MIN = 1;
export const FEEDBACK_RATING_MAX = 5;

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /**
     * 1-5 stars. Enforced at app layer (zod) AND at DB layer
     * (CHECK in migration) so a manual SQL insert can't smuggle
     * an out-of-range value into the admin queue.
     */
    rating: integer("rating").notNull(),

    /**
     * The candidate's free-text feedback. Length-validated only
     * at the API edge (2000 chars); DB stores unbounded TEXT so
     * a future cap change doesn't require a migration.
     */
    message: text("message").notNull(),

    /**
     * "OK to display this publicly on our home page with my
     * display name / role." Defaults to false — public surfacing
     * is opt-in. Even with `true`, the row must also be
     * `status='approved'` before any public render fires.
     */
    consentPublic: boolean("consent_public").notNull().default(false),

    /**
     * How the candidate would like to be credited on a public
     * testimonial. Optional and only meaningful when
     * `consent_public=true`. The widget hides these inputs when
     * the consent checkbox is unchecked.
     */
    displayName: text("display_name"),
    displayRole: text("display_role"),

    /**
     * One of `FEEDBACK_STATUSES`. Stored as TEXT + CHECK (see
     * migration) for the same reason as `outcome_type` — see
     * `outcomes.ts` file header.
     */
    status: text("status").notNull().default("pending"),

    /**
     * When the admin transitioned the row to `approved` (NULL
     * for pending / rejected). Distinct from `updatedAt` so the
     * partial testimonials index can sort by approval time
     * without surfacing rows that were edited but never
     * approved.
     */
    approvedAt: timestamp("approved_at", { withTimezone: true }),

    /**
     * Which admin user approved this row. `ON DELETE SET NULL`
     * so the approval timestamp survives the admin's user row
     * being deleted (rare, but the audit trail shouldn't depend
     * on the admin sticking around).
     */
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /**
     * Private admin commentary on this row. NEVER rendered
     * publicly — used by the admin queue UI to track why a row
     * was approved / rejected / deferred. Optional.
     */
    adminNotes: text("admin_notes"),

    /**
     * URL path the user was on when they opened the widget
     * (e.g. `/dashboard`, `/sessions/<uuid>`). Strip any query
     * string client-side before posting so we don't retain
     * one-time tokens or UTM params. NULL when the widget was
     * opened from a context the client couldn't determine.
     */
    pagePath: text("page_path"),

    /**
     * Second-stage curation gate. `status='approved'` makes a row
     * *eligible* for the home-page testimonials section; `featured`
     * makes it *actually appear*. Two-stage so the founder can
     * approve generously (audit trail, lets users see their feedback
     * was acknowledged) but curate tightly (pick 3-6 standouts for
     * the marketing surface).
     *
     * Invariant (enforced by CHECK in migration 0030): a row may
     * only be featured if it also has consent_public=true and a
     * non-null featured_order. The status='approved' precondition
     * is enforced in application code (admin UI + API guard) rather
     * than at the DB layer to avoid the "demote-then-cascade"
     * complexity of a CHECK that references mutable status.
     */
    featured: boolean("featured").notNull().default(false),

    /**
     * Display order for featured rows on the home page (lower
     * first). Nullable for non-featured rows. NOT enforced unique —
     * ties are broken by `approved_at DESC` so a casual reorder
     * doesn't require a multi-row transaction. The admin UI auto-
     * assigns max+1 when newly featuring a row, so collisions are
     * incidental.
     */
    featuredOrder: integer("featured_order"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // "My feedback" lookups — a future user-facing
    // `/settings/feedback` surface joins on this. Cheap to keep
    // now; expensive to add later once the table has volume.
    index("feedback_user_idx").on(table.userId),

    // Admin queue's default sort: pending newest-first. Compound
    // index covers (status filter) + (created_at DESC sort) in
    // one pass. Used by `listFeedback({ status })` in
    // `src/lib/feedback/admin-queries.ts`.
    index("feedback_status_created_idx").on(
      table.status,
      table.createdAt.desc(),
    ),

    // Partial index for the future testimonials query: only
    // approved + consent_public=true rows, ordered by approval
    // time. Empty for a long time while the admin queue is
    // empty, but it pre-shapes the query plan so the marketing
    // page render stays O(limit) once seeded.
    index("feedback_approved_idx")
      .on(table.approvedAt.desc())
      .where(
        sql`${table.status} = 'approved' AND ${table.consentPublic} = true`,
      ),

    // Partial index for the actual home-page testimonials render
    // (added in migration 0030). Narrower than `feedback_approved_idx`
    // — only featured rows — so the marketing surface fetch stays
    // O(N_featured) which we cap at 6 in the admin UI. Ordered by
    // featured_order ASC so the index satisfies the query's ORDER BY
    // without a sort step.
    index("feedback_featured_idx")
      .on(table.featuredOrder.asc())
      .where(
        sql`${table.status} = 'approved' AND ${table.consentPublic} = true AND ${table.featured} = true`,
      ),

    // The CHECK constraints on `rating` (1-5), `status`
    // (FEEDBACK_STATUSES), and the featured/featured_order/
    // consent_public invariant (migration 0030) are added in the
    // SQL migrations directly — the drizzle builder doesn't
    // currently model table-level CHECKs, and matching the
    // migration pattern we already use for
    // `session_outcomes.outcome_type` keeps the schema-vs-migration
    // boundary consistent.
  ],
);

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
