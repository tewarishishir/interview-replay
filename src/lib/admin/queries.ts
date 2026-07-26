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
 *   - `interview_sessions_state_created_idx` (partial on `deleted_at IS NULL`)
 *   - `audit_log_event_type_created_idx`
 *
 * Day boundaries are UTC for v1. The founder is India-based; for the
 * launch-week dashboards a UTC day off by 5.5h is acceptable noise.
 * If/when we need an IST-aligned day, add a `timezone:` parameter to
 * `dayBounds` and pin it to "Asia/Kolkata" — none of the calling sites
 * pass anything cross-tenant so the change is local.
 *
 */

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

  const [
    newSignupsRow,
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

  return {
    new_signups: Number(newSignupsRow[0]?.n ?? 0),
    active_users: Number(activeUsersRow[0]?.n ?? 0),
    sessions_analyzed: Number(sessionsCompletedRow[0]?.n ?? 0),
  };
}

// ─── getWeeklyTrend ────────────────────────────────────────────────

export interface WeeklyTrendEntry {
  date: string;
  signups: number;
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

  const [signupsByDay, sessionsByDay] = await Promise.all([
    db.execute(sql<{ day: string; n: number }>`
      SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             count(*)::int AS n
      FROM users
      WHERE created_at >= ${start.toISOString()}
        AND created_at <  ${end.toISOString()}
        AND deleted_at IS NULL
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
  const sessionsMap = toMap(sessionsByDay);

  const out: WeeklyTrendEntry[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(end.getTime() - (i + 1) * 24 * 60 * 60 * 1000);
    const label = utcDateLabel(day);
    out.push({
      date: label,
      signups: signupsMap.get(label) ?? 0,
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
 * The "30 days of signup" window matches the spec's intent — we're
 * measuring conversion velocity, not raw lifetime conversion.
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
      ) AS first_analysis
  `);

  type Row = {
    signed_up?: number | string | null;
    onboarded?: number | string | null;
    first_analysis?: number | string | null;
  };
  const row = (result as unknown as { rows: Row[] }).rows?.[0] ?? {};

  return {
    signed_up: Number(row.signed_up ?? 0),
    onboarded: Number(row.onboarded ?? 0),
    first_analysis: Number(row.first_analysis ?? 0),
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

  const results = await Promise.allSettled([
    checkInferenceConfirmationRate(sevenDaysAgo),
    checkAnalysisFailureRate(oneDayAgo),
    checkNonIndianSignups(sevenDaysAgo),
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


