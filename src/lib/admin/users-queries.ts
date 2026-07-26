import "server-only";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  CreditPackType,
  CreditPurchaseStatus,
  InterviewLevel,
  InterviewRoundType,
  InterviewSessionState,
  OutcomeType,
} from "@/lib/db/schema";

/**
 * Read-only queries powering the `/admin/users` list + detail
 * surfaces (Phase 2).
 *
 * All queries respect the user-tenancy invariant: this module is
 * the only place admin-side cross-tenant reads are allowed. The
 * `(admin)/layout.tsx` already gates `is_admin = true` on every
 * request; everything here trusts that gate and reads any user's
 * row by id without an ownership filter.
 *
 * Performance: every query is one round-trip. The list endpoint
 * uses the indexes added in migration 0026
 * (`users_created_at_idx`, `users_signup_country_idx`) plus the
 * pre-existing per-user composite indexes on `credit_purchases`
 * and `interview_sessions` for the lifetime-stats joins.
 */

// ─── filter inputs ──────────────────────────────────────────────────

export type UsersStatusFilter = "all" | "free" | "paying" | "churned";
export type UsersCountryFilter = "all" | "india" | "non_india";
export type UsersDateRangeFilter = "7d" | "30d" | "90d" | "all";
export type UsersSortKey = "recent_activity" | "highest_spend" | "session_count";

export interface ListUsersFilters {
  status: UsersStatusFilter;
  country: UsersCountryFilter;
  dateRange: UsersDateRangeFilter;
  sort: UsersSortKey;
  /** Free-text search over email + display_name, ILIKE. */
  search: string | null;
  /** 1-indexed page; PAGE_SIZE rows per page. */
  page: number;
  /** Override for "now" — used in tests to pin time. Defaults to real Date. */
  now?: Date;
}

export const PAGE_SIZE = 50;

export const DEFAULT_FILTERS: ListUsersFilters = {
  status: "all",
  country: "all",
  dateRange: "30d",
  sort: "recent_activity",
  search: null,
  page: 1,
};

// ─── list rows ─────────────────────────────────────────────────────

export interface UsersListRow {
  id: string;
  email: string;
  displayName: string | null;
  signupCountryCode: string | null;
  signupSubdivisionCode: string | null;
  signedUpAt: Date;
  freeCreditUsed: boolean;
  highestPack: CreditPackType | null;
  totalSpentInr: number;
  /** Most recent audit-log row's timestamp, or signup if no activity. */
  lastActivityAt: Date;
  sessionsCount: number;
}

export interface ListUsersResult {
  rows: UsersListRow[];
  totalCount: number;
  pageSize: number;
}

/**
 * One-round-trip user list with filters, search, and pagination.
 *
 * The query joins three correlated aggregates against the user
 * row:
 *   - `lifetime`     : sum(amount_paid_paise) for succeeded purchases,
 *                      max(created_at) for "highest pack" pricing.
 *   - `sessions_agg` : count + max(updated_at) of non-deleted sessions.
 *   - `activity`     : max(audit_log.created_at) for the "Last activity"
 *                      column. Coalesced to `users.created_at` when the
 *                      user has no audit history (brand-new signups
 *                      whose `audit_log` rows haven't landed yet — for
 *                      these "Last activity" reads as "Just signed up").
 *
 * The highest-pack ranking is encoded inline rather than as a CASE
 * over a pack-tier enum so the SQL is self-contained and doesn't
 * need a CTE — the only three active packs are starter/standard/heavy,
 * with legacy `pro` / `enterprise` / `heavy_prep` ranked at the
 * heavy tier so the column reads sensibly for grandfathered rows.
 */
export async function listUsers(filters: ListUsersFilters): Promise<ListUsersResult> {
  const now = filters.now ?? new Date();
  const search = filters.search?.trim();
  const offset = Math.max(0, (filters.page - 1) * PAGE_SIZE);

  // Dynamic WHERE clauses applied to the `users` row itself —
  // status / country / date-range / search all reduce the cohort
  // BEFORE the aggregates kick in. We build raw SQL fragments
  // qualified with the `u.` alias (not Drizzle column refs that
  // would emit the bare `"users".` prefix) so the predicate
  // composes cleanly with the LATERAL joins below.
  const conds: ReturnType<typeof sql>[] = [sql`u.deleted_at IS NULL`];

  if (filters.country === "india") {
    conds.push(sql`u.signup_country_code = 'IN'`);
  } else if (filters.country === "non_india") {
    conds.push(sql`u.signup_country_code IS NOT NULL`);
    conds.push(sql`u.signup_country_code <> 'IN'`);
  }

  if (filters.dateRange !== "all") {
    const days = filters.dateRange === "7d" ? 7 : filters.dateRange === "30d" ? 30 : 90;
    const since = daysAgo(now, days);
    conds.push(sql`u.created_at >= ${since.toISOString()}::timestamptz`);
  }

  if (search && search.length > 0) {
    const pattern = `%${escapeLike(search)}%`;
    conds.push(sql`(u.email ILIKE ${pattern} OR u.display_name ILIKE ${pattern})`);
  }

  // The status filter ("free" / "paying" / "churned") depends on
  // join aggregates, so it goes into the HAVING clause via raw SQL
  // below (Drizzle's typed query builder doesn't help with the
  // aggregate-side filter). The cohort WHERE above is what bounds
  // the table scan; the HAVING just narrows the result set.

  const whereSql = sql.join(conds, sql` AND `);

  // The aggregate subqueries are pinned by user_id and lifted via
  // LATERAL so a row with no purchases / sessions still appears
  // (LEFT JOIN LATERAL ... ON true).
  const sortOrder = (() => {
    switch (filters.sort) {
      case "highest_spend":
        return sql`COALESCE(lifetime.total_paise, 0) DESC, last_activity DESC`;
      case "session_count":
        return sql`COALESCE(sessions_agg.n, 0) DESC, last_activity DESC`;
      case "recent_activity":
      default:
        return sql`last_activity DESC`;
    }
  })();

  const havingSql = (() => {
    switch (filters.status) {
      case "free":
        return sql`COALESCE(lifetime.total_paise, 0) = 0`;
      case "paying":
        return sql`COALESCE(lifetime.total_paise, 0) > 0`;
      case "churned":
        // No activity in the last 30 days.
        return sql`(GREATEST(COALESCE(activity.last_event, u.created_at), u.created_at)
                    < ${daysAgo(now, 30).toISOString()}::timestamptz)`;
      case "all":
      default:
        return sql`true`;
    }
  })();

  const rowsResult = await db.execute(sql<{
    id: string;
    email: string;
    display_name: string | null;
    signup_country_code: string | null;
    signup_subdivision_code: string | null;
    free_credit_used: boolean;
    created_at: Date;
    last_activity: Date;
    sessions_count: number;
    total_paise: number;
    highest_pack: string | null;
  }>`
    SELECT
      u.id,
      u.email,
      u.display_name,
      u.signup_country_code,
      u.signup_subdivision_code,
      u.free_credit_used,
      u.created_at,
      GREATEST(COALESCE(activity.last_event, u.created_at), u.created_at) AS last_activity,
      COALESCE(sessions_agg.n, 0) AS sessions_count,
      COALESCE(lifetime.total_paise, 0) AS total_paise,
      lifetime.highest_pack
    FROM users u
    LEFT JOIN LATERAL (
      SELECT
        SUM(amount_paid_paise)::bigint AS total_paise,
        (
          SELECT pack_type::text
          FROM credit_purchases p2
          WHERE p2.user_id = u.id
            AND p2.status = 'succeeded'
          ORDER BY
            CASE p2.pack_type::text
              WHEN 'heavy' THEN 3
              WHEN 'heavy_prep' THEN 3
              WHEN 'enterprise' THEN 3
              WHEN 'standard' THEN 2
              WHEN 'pro' THEN 2
              WHEN 'starter' THEN 1
              ELSE 0
            END DESC,
            created_at DESC
          LIMIT 1
        ) AS highest_pack
      FROM credit_purchases
      WHERE user_id = u.id AND status = 'succeeded'
    ) AS lifetime ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, max(updated_at) AS last_session_at
      FROM interview_sessions s
      WHERE s.user_id = u.id AND s.deleted_at IS NULL
    ) AS sessions_agg ON true
    LEFT JOIN LATERAL (
      SELECT max(created_at) AS last_event
      FROM audit_log a
      WHERE a.user_id = u.id
    ) AS activity ON true
    WHERE ${whereSql}
      AND ${havingSql}
    ORDER BY ${sortOrder}
    LIMIT ${PAGE_SIZE}
    OFFSET ${offset}
  `);

  type Row = {
    id: string;
    email: string;
    display_name: string | null;
    signup_country_code: string | null;
    signup_subdivision_code: string | null;
    free_credit_used: boolean;
    created_at: Date | string;
    last_activity: Date | string;
    sessions_count: number | string;
    total_paise: number | string;
    highest_pack: string | null;
  };

  const rows = ((rowsResult as unknown as { rows: Row[] }).rows ?? []).map(
    (r): UsersListRow => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      signupCountryCode: r.signup_country_code,
      signupSubdivisionCode: r.signup_subdivision_code,
      freeCreditUsed: r.free_credit_used,
      highestPack: (r.highest_pack as CreditPackType | null) ?? null,
      totalSpentInr: Math.floor(Number(r.total_paise) / 100),
      signedUpAt: toDate(r.created_at),
      lastActivityAt: toDate(r.last_activity),
      sessionsCount: Number(r.sessions_count),
    }),
  );

  // Total count — same WHERE + HAVING as the page query, no
  // ORDER / LIMIT. Done as a second query to avoid the window-
  // function cost on every paged read.
  const totalResult = await db.execute(sql<{ n: number }>`
    SELECT count(*)::int AS n
    FROM (
      SELECT u.id
      FROM users u
      LEFT JOIN LATERAL (
        SELECT SUM(amount_paid_paise)::bigint AS total_paise
        FROM credit_purchases
        WHERE user_id = u.id AND status = 'succeeded'
      ) AS lifetime ON true
      LEFT JOIN LATERAL (
        SELECT max(created_at) AS last_event
        FROM audit_log a
        WHERE a.user_id = u.id
      ) AS activity ON true
      WHERE ${whereSql}
        AND ${havingSql}
    ) AS sub
  `);
  const totalCount = Number(
    (totalResult as unknown as { rows: Array<{ n: number | string }> }).rows?.[0]?.n ?? 0,
  );

  return { rows, totalCount, pageSize: PAGE_SIZE };
}

// ─── detail page ───────────────────────────────────────────────────

export interface UserSessionRow {
  id: string;
  companyName: string;
  roleTitle: string;
  level: InterviewLevel;
  roundType: InterviewRoundType;
  state: InterviewSessionState;
  createdAt: Date;
  outcomeType: OutcomeType | null;
}

export interface UserPaymentRow {
  id: string;
  status: CreditPurchaseStatus;
  packType: CreditPackType;
  amountInr: number;
  txnRef: string | null;
  txnId: string;
  paymentMode: string | null;
  createdAt: Date;
}

export interface UserNoteRow {
  id: string;
  note: string;
  adminEmail: string;
  adminName: string | null;
  createdAt: Date;
}

export interface UserDetail {
  id: string;
  email: string;
  displayName: string | null;
  signupCountryCode: string | null;
  signupSubdivisionCode: string | null;
  themePreference: string;
  signedUpAt: Date;
  lastActivityAt: Date;
  creditBalance: number;
  profile: {
    hasResume: boolean;
    projectsCount: number;
    storiesCount: number;
    targetLevels: string[];
  } | null;
  lifetime: {
    sessionsCount: number;
    creditsPurchased: number;
    creditsUsed: number;
    totalSpentInr: number;
  };
  sessions: UserSessionRow[];
  payments: UserPaymentRow[];
  notes: UserNoteRow[];
}

/**
 * Returns the full detail for one user. Five reads in parallel:
 *   1. user row + computed last-activity
 *   2. profile + counts (projects, stories, target levels)
 *   3. recent sessions (latest 20, with outcome)
 *   4. payments (full history)
 *   5. admin notes (newest-first, joined to admin user for the
 *      "left by …" attribution)
 *
 * Returns `null` if the user doesn't exist OR is soft-deleted —
 * the admin can't act on a deleted user (their FKs are restricted)
 * so a 404 is the right answer.
 */
export async function getUserDetail(userId: string): Promise<UserDetail | null> {
  const [
    userRow,
    profileRow,
    sessionRows,
    paymentRows,
    noteRows,
    activityRow,
    lifetimeRow,
  ] = await Promise.all([
    db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.name,
        signupCountryCode: schema.users.signupCountryCode,
        signupSubdivisionCode: schema.users.signupSubdivisionCode,
        themePreference: schema.users.themePreference,
        createdAt: schema.users.createdAt,
        creditBalance: schema.users.creditBalance,
      })
      .from(schema.users)
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
      .limit(1),

    db
      .select({
        userId: schema.userProfiles.userId,
        // "Has resume" is true when EITHER the parsed summary OR
        // the resume-saved timestamp is set — covers both the
        // upload-and-parse path and the manual-edit path.
        professionalSummary: schema.userProfiles.professionalSummary,
        resumeSavedAt: schema.userProfiles.resumeSavedAt,
        // Target levels live on the JSONB `levels` column.
        levels: schema.userProfiles.levels,
      })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId))
      .limit(1),

    db
      .select({
        id: schema.interviewSessions.id,
        companyName: schema.interviewSessions.companyName,
        roleTitle: schema.interviewSessions.roleTitle,
        level: schema.interviewSessions.level,
        roundType: schema.interviewSessions.roundType,
        state: schema.interviewSessions.state,
        createdAt: schema.interviewSessions.createdAt,
        outcomeType: schema.sessionOutcomes.outcomeType,
      })
      .from(schema.interviewSessions)
      .leftJoin(
        schema.sessionOutcomes,
        eq(schema.sessionOutcomes.sessionId, schema.interviewSessions.id),
      )
      .where(
        and(
          eq(schema.interviewSessions.userId, userId),
          isNull(schema.interviewSessions.deletedAt),
        ),
      )
      .orderBy(desc(schema.interviewSessions.createdAt))
      .limit(20),

    db
      .select({
        id: schema.creditPurchases.id,
        status: schema.creditPurchases.status,
        packType: schema.creditPurchases.packType,
        amountPaidPaise: schema.creditPurchases.amountPaidPaise,
        txnRef: schema.creditPurchases.txnRef,
        txnId: schema.creditPurchases.txnId,
        paymentMode: schema.creditPurchases.paymentMode,
        createdAt: schema.creditPurchases.createdAt,
      })
      .from(schema.creditPurchases)
      .where(eq(schema.creditPurchases.userId, userId))
      .orderBy(desc(schema.creditPurchases.createdAt)),

    db
      .select({
        id: schema.adminNotes.id,
        note: schema.adminNotes.note,
        createdAt: schema.adminNotes.createdAt,
        adminEmail: schema.users.email,
        adminName: schema.users.name,
      })
      .from(schema.adminNotes)
      .leftJoin(schema.users, eq(schema.users.id, schema.adminNotes.adminId))
      .where(eq(schema.adminNotes.userId, userId))
      .orderBy(desc(schema.adminNotes.createdAt)),

    db
      .select({
        lastEvent: sql<Date>`max(${schema.auditLog.createdAt})`,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId)),

    db.execute(sql<{
      sessions_count: number;
      credits_purchased: number;
      credits_used: number;
      total_paise: number;
      projects_count: number;
      stories_count: number;
    }>`
      SELECT
        (SELECT count(*)::int FROM interview_sessions
          WHERE user_id = ${userId} AND deleted_at IS NULL) AS sessions_count,
        (SELECT COALESCE(sum(credits_purchased), 0)::int FROM credit_purchases
          WHERE user_id = ${userId} AND status = 'succeeded') AS credits_purchased,
        (SELECT COALESCE(sum(-delta), 0)::int FROM credit_transactions
          WHERE user_id = ${userId} AND delta < 0) AS credits_used,
        (SELECT COALESCE(sum(amount_paid_paise), 0)::bigint FROM credit_purchases
          WHERE user_id = ${userId} AND status = 'succeeded') AS total_paise,
        (SELECT count(*)::int FROM projects WHERE user_id = ${userId}) AS projects_count,
        (SELECT count(*)::int FROM stories WHERE user_id = ${userId}) AS stories_count
    `),
  ]);

  const u = userRow[0];
  if (!u) return null;

  const lifetimeRowData =
    (lifetimeRow as unknown as {
      rows: Array<{
        sessions_count: number | string;
        credits_purchased: number | string;
        credits_used: number | string;
        total_paise: number | string;
        projects_count: number | string;
        stories_count: number | string;
      }>;
    }).rows?.[0] ?? null;

  const profile = profileRow[0]
    ? {
        hasResume:
          Boolean(profileRow[0].professionalSummary) ||
          profileRow[0].resumeSavedAt != null,
        projectsCount: Number(lifetimeRowData?.projects_count ?? 0),
        storiesCount: Number(lifetimeRowData?.stories_count ?? 0),
        targetLevels: Array.isArray(profileRow[0].levels)
          ? (profileRow[0].levels as string[])
          : [],
      }
    : null;

  const lastActivity = activityRow[0]?.lastEvent
    ? new Date(activityRow[0].lastEvent as unknown as string)
    : u.createdAt;

  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    signupCountryCode: u.signupCountryCode,
    signupSubdivisionCode: u.signupSubdivisionCode,
    themePreference: u.themePreference,
    signedUpAt: u.createdAt,
    lastActivityAt: lastActivity,
    creditBalance: u.creditBalance,
    profile,
    lifetime: {
      sessionsCount: Number(lifetimeRowData?.sessions_count ?? 0),
      creditsPurchased: Number(lifetimeRowData?.credits_purchased ?? 0),
      creditsUsed: Number(lifetimeRowData?.credits_used ?? 0),
      totalSpentInr: Math.floor(Number(lifetimeRowData?.total_paise ?? 0) / 100),
    },
    sessions: sessionRows.map((r) => ({
      id: r.id,
      companyName: r.companyName,
      roleTitle: r.roleTitle,
      level: r.level as InterviewLevel,
      roundType: r.roundType,
      state: r.state,
      createdAt: r.createdAt,
      outcomeType: (r.outcomeType as OutcomeType | null) ?? null,
    })),
    payments: paymentRows.map((r) => ({
      id: r.id,
      status: r.status,
      packType: r.packType,
      amountInr: Math.floor(r.amountPaidPaise / 100),
      txnRef: r.txnRef,
      txnId: r.txnId,
      paymentMode: r.paymentMode,
      createdAt: r.createdAt,
    })),
    notes: noteRows.map((r) => ({
      id: r.id,
      note: r.note,
      adminEmail: r.adminEmail ?? "(unknown)",
      adminName: r.adminName,
      createdAt: r.createdAt,
    })),
  };
}

// ─── helpers ───────────────────────────────────────────────────────

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function escapeLike(s: string): string {
  // ILIKE special chars: `%`, `_`, `\`. Escape so a user search for
  // "100%" doesn't match every row.
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

// Re-exports kept narrow so consumers don't accidentally reach into
// the underlying drizzle exports.
export type { CreditPackType, CreditPurchaseStatus } from "@/lib/db/schema";
