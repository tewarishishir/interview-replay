import "server-only";

import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * Read-only queries powering the (admin) dashboards.
 *
 * Performance budget (spec): every query here should run in under
 * 200ms on production data. Each query is one round-trip (no N+1)
 * and uses the indexes added in migration 0026:
 *
 *   - `users_created_at_idx` (partial on `deleted_at IS NULL`)
 *   - `credit_purchases_status_created_idx`
 *   - `interview_sessions_state_created_idx` (partial on `deleted_at IS NULL`)
 *   - `audit_log_event_type_created_idx`
 *
 * Day boundaries are UTC for v1. The founder is India-based; for the
 * launch-week dashboards a UTC day off by 5.5h is acceptable noise.
 * If/when we need an IST-aligned day, add a `timezone:` parameter to
 * `dayBounds` and pin it to "Asia/Kolkata" — none of the calling sites
 * pass anything cross-tenant so the change is local.
 *
 * "Variable cost per session" lives as a named constant rather than
 * a query parameter — the founder's runbook number is ₹50/session,
 * and changing it has business implications (re-papers gross margin
 * across every historical row in the dashboard) that should be a
 * code review, not a function arg.
 */

/**
 * Estimated variable cost per completed session (₹). Sourced from
 * the founder's cost analysis — transcription + LLM + a haircut for
 * the per-session infrastructure fraction. Tracked here as the single
 * source of truth so the Ops dashboard and the gross-margin
 * supporting line never drift.
 *
 * If this number moves more than ±20% the dashboards should call it
 * out — but for v1 we just hardcode and re-read every render.
 */
export const VARIABLE_COST_PER_SESSION_INR = 50;

/** [startMs, endMs) UTC bounds for the day containing `date`. */
function dayBounds(date: Date): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** "YYYY-MM-DD" UTC for `date`. Used as a chart-axis label. */
function utcDateLabel(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ─── getDailyMetrics ───────────────────────────────────────────────

export interface DailyMetrics {
  /** New `users` rows in the day. Soft-deleted excluded. */
  new_signups: number;
  /**
   * Users whose FIRST `credit_purchases` row with status='succeeded'
   * landed in the day. NOT "succeeded purchases today by users who
   * later turned out to be paying" — strictly first-purchase
   * conversions per day.
   */
  new_paying_users: number;
  /**
   * Sum of `credit_purchases.amount_paid_paise` / 100 for succeeded
   * rows in the day. Returned as INR (integer rupees rounded down;
   * the spec asks for `₹X,XXX` formatting). Includes the embedded
   * GST portion — the dashboard line is gross revenue, not net.
   */
  revenue_inr: number;
  /**
   * Distinct user count from `audit_log.user_id` in the day. We use
   * the audit log (not interview_sessions) because the spec asks for
   * "the user did anything", which includes signing in, viewing
   * pages, recording outcomes, etc. — all of which already produce
   * audit-log rows under the existing event-type catalog.
   *
   * Cap at the day's window so a long-running browser tab from
   * yesterday doesn't get counted twice.
   */
  active_users: number;
  /**
   * `interview_sessions` rows whose `state='complete'` AND whose
   * row landed in the day. Strictly speaking the spec asks for "the
   * state transitioned to complete in the given day", but the
   * `interview_sessions` table has no `state_changed_at` column —
   * adding one would be a destructive backfill, and the existing
   * `updated_at` is the right proxy for "when did this session
   * finish analysis". We use `updated_at` for completed rows so
   * a session created weeks ago that just finished analysis today
   * counts toward today's number.
   */
  sessions_analyzed: number;
}

export async function getDailyMetrics(date: Date): Promise<DailyMetrics> {
  const { start, end } = dayBounds(date);

  // Five reads in parallel — they hit independent indexes and the
  // dashboard renders the cards independently anyway.
  const [
    newSignupsRow,
    newPayingUsersRow,
    revenueRow,
    activeUsersRow,
    sessionsCompletedRow,
  ] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.users)
      .where(
        and(
          gte(schema.users.createdAt, start),
          lt(schema.users.createdAt, end),
          isNull(schema.users.deletedAt),
        ),
      ),

    // First-paying-user count: window over succeeded purchases per
    // user, pick the earliest, then count users whose earliest falls
    // in the day. Done as one query so we don't iterate N users in
    // app code.
    db.execute(sql<{ n: number }>`
      SELECT count(*)::int AS n
      FROM (
        SELECT user_id,
               min(created_at) AS first_succeeded
        FROM credit_purchases
        WHERE status = 'succeeded'
          AND user_id IS NOT NULL
        GROUP BY user_id
      ) AS firsts
      WHERE firsts.first_succeeded >= ${start.toISOString()}
        AND firsts.first_succeeded <  ${end.toISOString()}
    `),

    db
      .select({
        // coalesce so a day with zero succeeded purchases returns 0,
        // not NULL.
        paise: sql<number>`coalesce(sum(${schema.creditPurchases.amountPaidPaise}), 0)::bigint`,
      })
      .from(schema.creditPurchases)
      .where(
        and(
          eq(schema.creditPurchases.status, "succeeded"),
          gte(schema.creditPurchases.createdAt, start),
          lt(schema.creditPurchases.createdAt, end),
        ),
      ),

    db
      .select({
        n: sql<number>`count(distinct ${schema.auditLog.userId})::int`,
      })
      .from(schema.auditLog)
      .where(
        and(
          gte(schema.auditLog.createdAt, start),
          lt(schema.auditLog.createdAt, end),
          sql`${schema.auditLog.userId} IS NOT NULL`,
        ),
      ),

    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.interviewSessions)
      .where(
        and(
          eq(schema.interviewSessions.state, "complete"),
          gte(schema.interviewSessions.updatedAt, start),
          lt(schema.interviewSessions.updatedAt, end),
          isNull(schema.interviewSessions.deletedAt),
        ),
      ),
  ]);

  // `db.execute` returns the raw pg driver result; the typed wrapper
  // queries hand back the row objects directly.
  // pg's `node-postgres` returns numeric `count` columns as strings;
  // the `::int` cast above + Number() here makes both shapes safe.
  type CountRow = { n?: number | string | null };
  const firstPayingRow = (newPayingUsersRow as unknown as { rows: CountRow[] })
    .rows?.[0];

  const paiseTotal = revenueRow[0]?.paise ?? 0;
  // `bigint` columns come back as strings from node-pg; normalize.
  const paiseNum = typeof paiseTotal === "string" ? Number(paiseTotal) : Number(paiseTotal);

  return {
    new_signups: Number(newSignupsRow[0]?.n ?? 0),
    new_paying_users: Number(firstPayingRow?.n ?? 0),
    revenue_inr: Math.floor(paiseNum / 100),
    active_users: Number(activeUsersRow[0]?.n ?? 0),
    sessions_analyzed: Number(sessionsCompletedRow[0]?.n ?? 0),
  };
}

// ─── getWeeklyTrend ────────────────────────────────────────────────

export interface WeeklyTrendEntry {
  date: string;
  signups: number;
  paying_users: number;
  sessions: number;
}

/**
 * Returns 7 entries, one per day, going back from `endDate` (inclusive).
 * Each entry's `date` is `YYYY-MM-DD` in UTC. The chart renders these
 * in ascending date order — same order returned here.
 *
 * Implementation note: we issue THREE GROUP-BY queries (one per
 * metric) and zip the results client-side. The alternative — seven
 * sequential `getDailyMetrics` calls — would be 35 round-trips per
 * page render, which blows the 200ms budget even with hot caches.
 */
export async function getWeeklyTrend(endDate: Date): Promise<WeeklyTrendEntry[]> {
  const { end } = dayBounds(endDate);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [signupsByDay, payingByDay, sessionsByDay] = await Promise.all([
    db.execute(sql<{ day: string; n: number }>`
      SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             count(*)::int AS n
      FROM users
      WHERE created_at >= ${start.toISOString()}
        AND created_at <  ${end.toISOString()}
        AND deleted_at IS NULL
      GROUP BY day
    `),

    // First-succeeded purchase per user, grouped by day.
    db.execute(sql<{ day: string; n: number }>`
      SELECT to_char(date_trunc('day', firsts.first_succeeded AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             count(*)::int AS n
      FROM (
        SELECT user_id,
               min(created_at) AS first_succeeded
        FROM credit_purchases
        WHERE status = 'succeeded'
          AND user_id IS NOT NULL
        GROUP BY user_id
      ) AS firsts
      WHERE firsts.first_succeeded >= ${start.toISOString()}
        AND firsts.first_succeeded <  ${end.toISOString()}
      GROUP BY day
    `),

    db.execute(sql<{ day: string; n: number }>`
      SELECT to_char(date_trunc('day', updated_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             count(*)::int AS n
      FROM interview_sessions
      WHERE state = 'complete'
        AND updated_at >= ${start.toISOString()}
        AND updated_at <  ${end.toISOString()}
        AND deleted_at IS NULL
      GROUP BY day
    `),
  ]);

  type Row = { day: string; n: number | string };
  const toMap = (result: unknown): Map<string, number> => {
    const rows = (result as { rows: Row[] }).rows ?? [];
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.day, Number(r.n));
    return map;
  };

  const signupsMap = toMap(signupsByDay);
  const payingMap = toMap(payingByDay);
  const sessionsMap = toMap(sessionsByDay);

  const out: WeeklyTrendEntry[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(end.getTime() - (i + 1) * 24 * 60 * 60 * 1000);
    const label = utcDateLabel(day);
    out.push({
      date: label,
      signups: signupsMap.get(label) ?? 0,
      paying_users: payingMap.get(label) ?? 0,
      sessions: sessionsMap.get(label) ?? 0,
    });
  }
  return out;
}

// ─── getFunnel ─────────────────────────────────────────────────────

export interface FunnelMetrics {
  signed_up: number;
  onboarded: number;
  first_analysis: number;
  bought_pack: number;
}

/**
 * Conversion funnel over [startDate, endDate].
 *
 * Cohort = users whose `created_at` falls in the range.
 *   - signed_up      : |cohort|
 *   - onboarded      : cohort ∩ (has user_profiles row OR has at least
 *                     one interview_sessions row created within 30 days)
 *   - first_analysis : cohort ∩ (has at least one interview_sessions
 *                     with state='complete' AND created within 30 days
 *                     of that user's signup)
 *   - bought_pack    : cohort ∩ (has at least one credit_purchases row
 *                     status='succeeded' AND created within 30 days of
 *                     signup)
 *
 * The "30 days of signup" window matches the spec's intent — we're
 * measuring conversion velocity, not raw lifetime conversion. A user
 * who signed up six months ago and bought yesterday is NOT counted
 * in `bought_pack`; that's a "reactivation" story, not a funnel one.
 *
 * Returned as a single round-trip via four correlated subqueries
 * against the cohort — easier to read AND faster than four separate
 * count(*) queries, because the cohort scan happens once.
 *
 * "onboarded" uses the spec's fallback definition since v1 doesn't
 * have `users.profile_skipped`. If/when we add that column, the
 * `OR EXISTS (interview_sessions...)` branch goes away and the
 * `OR users.profile_skipped = true` branch replaces it.
 */
export async function getFunnel(
  startDate: Date,
  endDate: Date,
): Promise<FunnelMetrics> {
  const result = await db.execute(sql<{
    signed_up: number;
    onboarded: number;
    first_analysis: number;
    bought_pack: number;
  }>`
    WITH cohort AS (
      SELECT id, created_at
      FROM users
      WHERE created_at >= ${startDate.toISOString()}
        AND created_at <  ${endDate.toISOString()}
        AND deleted_at IS NULL
    )
    SELECT
      (SELECT count(*)::int FROM cohort) AS signed_up,
      (
        SELECT count(*)::int
        FROM cohort c
        WHERE EXISTS (
          SELECT 1 FROM user_profiles p WHERE p.user_id = c.id
        )
        OR EXISTS (
          SELECT 1 FROM interview_sessions s
          WHERE s.user_id = c.id
            AND s.deleted_at IS NULL
        )
      ) AS onboarded,
      (
        SELECT count(*)::int
        FROM cohort c
        WHERE EXISTS (
          SELECT 1 FROM interview_sessions s
          WHERE s.user_id = c.id
            AND s.state = 'complete'
            AND s.deleted_at IS NULL
            AND s.created_at <= c.created_at + interval '30 days'
        )
      ) AS first_analysis,
      (
        SELECT count(*)::int
        FROM cohort c
        WHERE EXISTS (
          SELECT 1 FROM credit_purchases p
          WHERE p.user_id = c.id
            AND p.status = 'succeeded'
            AND p.created_at <= c.created_at + interval '30 days'
        )
      ) AS bought_pack
  `);

  type Row = {
    signed_up?: number | string | null;
    onboarded?: number | string | null;
    first_analysis?: number | string | null;
    bought_pack?: number | string | null;
  };
  const row = (result as unknown as { rows: Row[] }).rows?.[0] ?? {};

  return {
    signed_up: Number(row.signed_up ?? 0),
    onboarded: Number(row.onboarded ?? 0),
    first_analysis: Number(row.first_analysis ?? 0),
    bought_pack: Number(row.bought_pack ?? 0),
  };
}

// ─── getRevenueAndCost ────────────────────────────────────────────

export interface RevenueAndCost {
  revenue_inr: number;
  variable_cost_inr_estimate: number;
  gross_margin_inr: number;
  /** Integer percentage (rounded). Defined as 0 when revenue is 0. */
  gross_margin_pct: number;
  packs_sold: number;
}

/**
 * Revenue + (estimated) variable cost over [startDate, endDate].
 *
 * "variable_cost" uses the runbook's flat ₹50/session figure (see
 * `VARIABLE_COST_PER_SESSION_INR`) — for v1 we don't try to
 * proportionally split transcription/LLM per-session bills, the
 * average is what the founder watches week-over-week.
 *
 * `packs_sold` counts succeeded purchases (not credits granted) so
 * the "avg ₹X per pack" supporting line on the dashboard makes
 * sense ("3 packs sold @ ₹600 avg" vs. "3 packs sold @ 23 credits avg").
 */
export async function getRevenueAndCost(
  startDate: Date,
  endDate: Date,
): Promise<RevenueAndCost> {
  const [revenueRow, sessionsRow] = await Promise.all([
    db
      .select({
        paise: sql<number>`coalesce(sum(${schema.creditPurchases.amountPaidPaise}), 0)::bigint`,
        packs: sql<number>`count(*)::int`,
      })
      .from(schema.creditPurchases)
      .where(
        and(
          eq(schema.creditPurchases.status, "succeeded"),
          gte(schema.creditPurchases.createdAt, startDate),
          lt(schema.creditPurchases.createdAt, endDate),
        ),
      ),

    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.interviewSessions)
      .where(
        and(
          eq(schema.interviewSessions.state, "complete"),
          gte(schema.interviewSessions.updatedAt, startDate),
          lt(schema.interviewSessions.updatedAt, endDate),
          isNull(schema.interviewSessions.deletedAt),
        ),
      ),
  ]);

  const paiseTotal = revenueRow[0]?.paise ?? 0;
  const paiseNum = typeof paiseTotal === "string" ? Number(paiseTotal) : Number(paiseTotal);
  const revenue = Math.floor(paiseNum / 100);
  const packs = Number(revenueRow[0]?.packs ?? 0);
  const sessions = Number(sessionsRow[0]?.n ?? 0);
  const cost = sessions * VARIABLE_COST_PER_SESSION_INR;
  const margin = revenue - cost;
  const marginPct = revenue > 0 ? Math.round((margin / revenue) * 100) : 0;

  return {
    revenue_inr: revenue,
    variable_cost_inr_estimate: cost,
    gross_margin_inr: margin,
    gross_margin_pct: marginPct,
    packs_sold: packs,
  };
}

// ─── getHealthAlerts ──────────────────────────────────────────────

export type HealthAlertSeverity = "info" | "warning" | "critical";

export interface HealthAlert {
  severity: HealthAlertSeverity;
  title: string;
  description: string;
  /** Time-scope label rendered on the right of the alert card. */
  scope: string;
}

/**
 * Run every health check the runbook cares about and return the
 * alerts that tripped. Severity order in the UI (the page sorts):
 * critical → warning → info.
 *
 * Each check is independent — one failing DB query MUST NOT mask
 * the others. We Promise.allSettled so a transient blip in one
 * count returns "no alert for that check" rather than blanking the
 * whole panel.
 *
 * Skipped for v1: guardrail trip rate check. Would need a log
 * aggregation query; intentionally deferred.
 */
export async function getHealthAlerts(now: Date = new Date()): Promise<HealthAlert[]> {
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const today = dayBounds(now);

  const results = await Promise.allSettled([
    checkInferenceConfirmationRate(sevenDaysAgo),
    checkAnalysisFailureRate(oneDayAgo),
    checkNonIndianSignups(sevenDaysAgo),
    checkPaymentFailures(oneDayAgo),
    checkDailyRevenueDrop(today.start, sevenDaysAgo),
    // TODO(v1.1): add guardrail trip rate check (needs log aggregation).
  ]);

  const alerts: HealthAlert[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      alerts.push(r.value);
    } else if (r.status === "rejected") {
      console.error("[admin/queries] health check failed:", r.reason);
    }
  }

  const order = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity]);
  return alerts;
}

async function checkInferenceConfirmationRate(since: Date): Promise<HealthAlert | null> {
  const result = await db
    .select({
      total: sql<number>`count(*) filter (where ${schema.artifacts.source} = 'ai_inferred' and ${schema.artifacts.aiConfidence} = 'high')::int`,
      confirmed: sql<number>`count(*) filter (where ${schema.artifacts.source} = 'ai_inferred' and ${schema.artifacts.aiConfidence} = 'high' and ${schema.artifacts.userConfirmedAt} IS NOT NULL)::int`,
    })
    .from(schema.artifacts)
    .where(gte(schema.artifacts.createdAt, since));

  const total = Number(result[0]?.total ?? 0);
  const confirmed = Number(result[0]?.confirmed ?? 0);
  // Below the threshold-size where the ratio is meaningful — don't
  // alert on noise.
  if (total < 10) return null;
  const rate = confirmed / total;
  const pct = Math.round(rate * 100);

  if (rate < 0.5) {
    return {
      severity: "critical",
      title: `Inference confirmation rate is ${pct}%`,
      description: `${confirmed} of ${total} high-confidence AI-inferred questions confirmed by the candidate. Investigate the inference prompt and the review-step UX.`,
      scope: "last 7 days",
    };
  }
  if (rate < 0.7) {
    return {
      severity: "warning",
      title: `Inference confirmation rate is ${pct}%`,
      description: `${confirmed} of ${total} high-confidence AI-inferred questions confirmed. Below the 70% target — investigate prompt drift or low-quality transcripts.`,
      scope: "last 7 days",
    };
  }
  return null;
}

async function checkAnalysisFailureRate(since: Date): Promise<HealthAlert | null> {
  const result = await db
    .select({
      complete: sql<number>`count(*) filter (where ${schema.interviewSessions.state} = 'complete')::int`,
      failed: sql<number>`count(*) filter (where ${schema.interviewSessions.state} = 'failed')::int`,
    })
    .from(schema.interviewSessions)
    .where(
      and(
        gte(schema.interviewSessions.updatedAt, since),
        isNull(schema.interviewSessions.deletedAt),
      ),
    );

  const complete = Number(result[0]?.complete ?? 0);
  const failed = Number(result[0]?.failed ?? 0);
  const denom = complete + failed;
  if (denom < 5) return null;
  const rate = failed / denom;
  const pct = Math.round(rate * 100);

  if (rate > 0.1) {
    return {
      severity: "critical",
      title: `Analysis failure rate is ${pct}%`,
      description: `${failed} of ${denom} sessions failed analysis. Check worker errors and recent LLM/transcription incidents.`,
      scope: "last 24 hours",
    };
  }
  if (rate > 0.05) {
    return {
      severity: "warning",
      title: `Analysis failure rate is ${pct}%`,
      description: `${failed} of ${denom} sessions failed analysis. Above the 5% target — review failure reasons.`,
      scope: "last 24 hours",
    };
  }
  return null;
}

async function checkNonIndianSignups(since: Date): Promise<HealthAlert | null> {
  const result = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.users)
    .where(
      and(
        gte(schema.users.createdAt, since),
        isNull(schema.users.deletedAt),
        sql`${schema.users.signupCountryCode} IS NOT NULL AND ${schema.users.signupCountryCode} <> 'IN'`,
      ),
    );

  const n = Number(result[0]?.n ?? 0);
  if (n === 0) return null;
  return {
    severity: "info",
    title: `${n} non-Indian signup${n === 1 ? "" : "s"}`,
    description: `Run the abuse-triage runbook to confirm these are organic.`,
    scope: "last 7 days",
  };
}

async function checkPaymentFailures(since: Date): Promise<HealthAlert | null> {
  const result = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.creditPurchases)
    .where(
      and(
        eq(schema.creditPurchases.status, "failed"),
        gte(schema.creditPurchases.createdAt, since),
      ),
    );

  const n = Number(result[0]?.n ?? 0);
  if (n <= 5) return null;
  return {
    severity: "warning",
    title: `${n} payment failures`,
    description: `Above the 5/day threshold. Check payment processor for declined patterns.`,
    scope: "last 24 hours",
  };
}

async function checkDailyRevenueDrop(
  todayStart: Date,
  sevenDaysAgo: Date,
): Promise<HealthAlert | null> {
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const [todayRow, sevenDayRow] = await Promise.all([
    db
      .select({
        paise: sql<number>`coalesce(sum(${schema.creditPurchases.amountPaidPaise}), 0)::bigint`,
      })
      .from(schema.creditPurchases)
      .where(
        and(
          eq(schema.creditPurchases.status, "succeeded"),
          gte(schema.creditPurchases.createdAt, todayStart),
          lt(schema.creditPurchases.createdAt, todayEnd),
        ),
      ),
    db
      .select({
        paise: sql<number>`coalesce(sum(${schema.creditPurchases.amountPaidPaise}), 0)::bigint`,
      })
      .from(schema.creditPurchases)
      .where(
        and(
          eq(schema.creditPurchases.status, "succeeded"),
          gte(schema.creditPurchases.createdAt, sevenDaysAgo),
          lt(schema.creditPurchases.createdAt, todayStart),
        ),
      ),
  ]);

  const toInr = (paise: number | string | null | undefined): number => {
    const n = typeof paise === "string" ? Number(paise) : Number(paise ?? 0);
    return Math.floor(n / 100);
  };
  const today = toInr(todayRow[0]?.paise);
  const sevenTotal = toInr(sevenDayRow[0]?.paise);
  const sevenAvg = sevenTotal / 7;

  // Only meaningful when the 7-day total is non-trivial — otherwise
  // a slow week ago would yield a "drop" the moment today logs a
  // single succeeded purchase. Spec threshold: ₹5000 7-day total.
  if (sevenTotal < 5000) return null;
  if (today >= sevenAvg * 0.3) return null;

  return {
    severity: "warning",
    title: `Today's revenue is ₹${today.toLocaleString("en-IN")} vs ₹${Math.round(sevenAvg).toLocaleString("en-IN")} 7-day avg`,
    description: `Below 30% of the 7-day average. Check for outage/incident.`,
    scope: "today",
  };
}

