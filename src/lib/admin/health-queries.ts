import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Read-only queries powering the `/admin/health` Product Health
 * surface (Phase 3).
 *
 * Grouped into four sections that match the page layout:
 *
 *   1. `getAiQualityMetrics`    — AI inference acceptance,
 *      analysis throughput, failed-analysis count, average
 *      analyze-to-report latency.
 *
 *   2. `getInfrastructureMetrics` — 7-day session volume series,
 *      mean recorded session length, monthly infra-cost figure
 *      pulled from `MONTHLY_INFRA_COST_INR` (operator-set env
 *      var — we have no cost-attribution telemetry to compute
 *      it from existing tables).
 *
 *   3. `getGeoMetrics` — signups grouped by country (last 30
 *      days), plus signups grouped by subdivision for India
 *      specifically. Feeds the country bar chart that the user
 *      requested explicitly on the geo monitoring section.
 *
 *   4. `getEngagementMetrics` — profile-completeness histogram,
 *      rebuild adoption (% of active users), outcomes-recorded
 *      rate (% of complete sessions with a follow-up outcome
 *      logged).
 *
 * Total query budget: 8 reads, all on indexed columns, parallel
 * via Promise.all. The whole snapshot must come in under ~400ms
 * on production-sized data — the page renders server-side so the
 * full latency lands in the first paint.
 */

// ─── AI quality ───────────────────────────────────────────────────

export interface AiQualityMetrics {
  /** Sessions that hit `state='failed'` in the last 7 days. */
  failedSessions7d: number;
  /** All sessions completed in the last 7 days (denominator). */
  completedSessions7d: number;
  /** Failure rate as a 0..1 float; 0 when no sessions ran. */
  failureRate7d: number;

  /**
   * Average seconds from session creation to first report row.
   * Last 7 days, complete-state sessions only. Null when no
   * sessions analyzed in window.
   */
  avgAnalysisSeconds7d: number | null;

  /**
   * Inference-acceptance rate: out of all `ai_inferred` artifacts
   * created in the last 30 days, what fraction WEREN'T dismissed
   * by the candidate. Reads the user's signal — high acceptance
   * = the LLM's question inferences are good enough to keep.
   */
  inferenceAcceptanceRate30d: number | null;
  inferenceArtifactsTotal30d: number;
}

export async function getAiQualityMetrics(now: Date = new Date()): Promise<AiQualityMetrics> {
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const result = await db.execute(sql<{
    failed_sessions: number;
    completed_sessions: number;
    avg_analysis_seconds: number | null;
    inference_total: number;
    inference_accepted: number;
  }>`
    SELECT
      (SELECT count(*)::int
        FROM interview_sessions
        WHERE deleted_at IS NULL
          AND state = 'failed'
          AND created_at >= ${since7d.toISOString()}::timestamptz) AS failed_sessions,
      (SELECT count(*)::int
        FROM interview_sessions
        WHERE deleted_at IS NULL
          AND state = 'complete'
          AND created_at >= ${since7d.toISOString()}::timestamptz) AS completed_sessions,
      (SELECT AVG(EXTRACT(EPOCH FROM (r.created_at - s.created_at)))::float
        FROM interview_sessions s
        JOIN reports r ON r.session_id = s.id
        WHERE s.deleted_at IS NULL
          AND s.state = 'complete'
          AND s.created_at >= ${since7d.toISOString()}::timestamptz) AS avg_analysis_seconds,
      (SELECT count(*)::int
        FROM artifacts
        WHERE source = 'ai_inferred'
          AND created_at >= ${since30d.toISOString()}::timestamptz) AS inference_total,
      (SELECT count(*)::int
        FROM artifacts
        WHERE source = 'ai_inferred'
          AND dismissed_at IS NULL
          AND created_at >= ${since30d.toISOString()}::timestamptz) AS inference_accepted
  `);

  const row =
    (result as unknown as {
      rows: Array<{
        failed_sessions: number | string;
        completed_sessions: number | string;
        avg_analysis_seconds: number | string | null;
        inference_total: number | string;
        inference_accepted: number | string;
      }>;
    }).rows?.[0] ?? null;

  const failed = Number(row?.failed_sessions ?? 0);
  const completed = Number(row?.completed_sessions ?? 0);
  const total = failed + completed;
  const inferenceTotal = Number(row?.inference_total ?? 0);
  const inferenceAccepted = Number(row?.inference_accepted ?? 0);

  return {
    failedSessions7d: failed,
    completedSessions7d: completed,
    failureRate7d: total === 0 ? 0 : failed / total,
    avgAnalysisSeconds7d:
      row?.avg_analysis_seconds == null
        ? null
        : Number(row.avg_analysis_seconds),
    inferenceArtifactsTotal30d: inferenceTotal,
    inferenceAcceptanceRate30d:
      inferenceTotal === 0 ? null : inferenceAccepted / inferenceTotal,
  };
}

// ─── Infrastructure ───────────────────────────────────────────────

export interface InfraMetrics {
  /** 7-day series of session counts (oldest → newest). */
  sessionsByDay: Array<{ date: string; count: number }>;
  /** Average recorded session length in seconds (last 30d). */
  avgSessionSeconds30d: number | null;
  /**
   * Operator-set monthly infrastructure cost in INR. We have no
   * tables to derive this from — render whatever the env var
   * carries, null when unset. The page surfaces "Set
   * `MONTHLY_INFRA_COST_INR` to populate" when null so the
   * operator knows what to do.
   */
  monthlyInfraCostInr: number | null;
}

export async function getInfraMetrics(now: Date = new Date()): Promise<InfraMetrics> {
  // Build the 7-day window starting from "today-6" so the chart
  // shows 7 buckets ending today. The generate_series gives us
  // every day even on zero-volume days, so the chart never has
  // a gap.
  const start = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);

  // Run both queries in parallel — previously sequential, which doubled latency.
  const [sessionsByDay, avgRow] = await Promise.all([
    db.execute(sql<{
      bucket: Date;
      n: number;
    }>`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', ${start.toISOString()}::timestamptz),
          date_trunc('day', ${now.toISOString()}::timestamptz),
          interval '1 day'
        ) AS bucket
      )
      SELECT
        d.bucket AS bucket,
        COALESCE(count(s.id), 0)::int AS n
      FROM days d
      LEFT JOIN interview_sessions s
        ON date_trunc('day', s.created_at) = d.bucket
        AND s.deleted_at IS NULL
      GROUP BY d.bucket
      ORDER BY d.bucket ASC
    `),
    db.execute(sql<{
      avg_seconds: number | null;
    }>`
      SELECT AVG(duration_seconds)::float AS avg_seconds
      FROM audio_files
      WHERE created_at >= ${new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz
        AND deleted_at IS NULL
    `),
  ]);

  const rawSeries =
    (sessionsByDay as unknown as {
      rows: Array<{ bucket: Date | string; n: number | string }>;
    }).rows ?? [];

  return {
    sessionsByDay: rawSeries.map((r) => ({
      date: toIsoDate(r.bucket),
      count: Number(r.n),
    })),
    avgSessionSeconds30d:
      ((avgRow as unknown as { rows: Array<{ avg_seconds: number | string | null }> }).rows?.[0]
        ?.avg_seconds ?? null) === null
        ? null
        : Number(
            (avgRow as unknown as { rows: Array<{ avg_seconds: number | string | null }> })
              .rows[0]!.avg_seconds,
          ),
    monthlyInfraCostInr:
      env.MONTHLY_INFRA_COST_INR != null && env.MONTHLY_INFRA_COST_INR > 0
        ? env.MONTHLY_INFRA_COST_INR
        : null,
  };
}

// ─── Geo ──────────────────────────────────────────────────────────

export interface GeoMetrics {
  /** Signups grouped by country code (descending), last 30 days. */
  signupsByCountry30d: Array<{
    countryCode: string;
    label: string;
    count: number;
  }>;
  /**
   * Signups grouped by subdivision for `IN` users in the last
   * 90 days. Empty when the operator doesn't have the City DB
   * installed (every row has subdivisionCode null).
   */
  indianSignupsBySubdivision90d: Array<{
    subdivisionCode: string;
    count: number;
  }>;
  /** Total signups in last 30d across all countries (denominator). */
  totalSignups30d: number;
  /**
   * Lifetime signups by country (all-time). Same shape as
   * `signupsByCountry30d` — used by the page's second chart
   * tab.
   */
  signupsByCountryAllTime: Array<{
    countryCode: string;
    label: string;
    count: number;
  }>;
}

export async function getGeoMetrics(now: Date = new Date()): Promise<GeoMetrics> {
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const since90d = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const [byCountry30d, byCountryAll, bySubdivision] = await Promise.all([
    db.execute(sql<{ country: string | null; n: number }>`
      SELECT COALESCE(signup_country_code, '??') AS country, count(*)::int AS n
      FROM users
      WHERE deleted_at IS NULL
        AND created_at >= ${since30d.toISOString()}::timestamptz
      GROUP BY signup_country_code
      ORDER BY n DESC
    `),
    db.execute(sql<{ country: string | null; n: number }>`
      SELECT COALESCE(signup_country_code, '??') AS country, count(*)::int AS n
      FROM users
      WHERE deleted_at IS NULL
      GROUP BY signup_country_code
      ORDER BY n DESC
      LIMIT 20
    `),
    db.execute(sql<{ subdivision: string; n: number }>`
      SELECT signup_subdivision_code AS subdivision, count(*)::int AS n
      FROM users
      WHERE deleted_at IS NULL
        AND signup_country_code = 'IN'
        AND signup_subdivision_code IS NOT NULL
        AND created_at >= ${since90d.toISOString()}::timestamptz
      GROUP BY signup_subdivision_code
      ORDER BY n DESC
      LIMIT 20
    `),
  ]);

  const rows30 = ((byCountry30d as unknown as { rows: Array<{ country: string; n: number | string }> })
    .rows ?? []).map((r) => ({
    countryCode: r.country,
    label: r.country === "??" ? "Unknown" : r.country,
    count: Number(r.n),
  }));
  const totalSignups30d = rows30.reduce((acc, r) => acc + r.count, 0);

  const rowsAll = ((byCountryAll as unknown as { rows: Array<{ country: string; n: number | string }> })
    .rows ?? []).map((r) => ({
    countryCode: r.country,
    label: r.country === "??" ? "Unknown" : r.country,
    count: Number(r.n),
  }));

  const rowsSub = ((bySubdivision as unknown as {
    rows: Array<{ subdivision: string; n: number | string }>;
  }).rows ?? []).map((r) => ({
    subdivisionCode: r.subdivision,
    count: Number(r.n),
  }));

  return {
    signupsByCountry30d: rows30,
    indianSignupsBySubdivision90d: rowsSub,
    totalSignups30d,
    signupsByCountryAllTime: rowsAll,
  };
}

// ─── Engagement ───────────────────────────────────────────────────

export interface EngagementMetrics {
  /**
   * Histogram of profile completeness: 0/4, 1/4, 2/4, 3/4, 4/4
   * across all non-deleted users. A "section" is complete when
   * the user has data in it (resume saved, ≥1 project, ≥1 story,
   * ≥1 target level).
   */
  profileCompleteness: Array<{ completed: number; users: number }>;

  /**
   * Story rebuild adoption: of users with ≥1 complete session in
   * the last 30 days, how many used the rebuild flow at least
   * once (ever).
   */
  rebuildAdoption: {
    activeUsers30d: number;
    rebuildUsersEver: number;
    rate: number;
  };

  /**
   * Outcomes-recorded rate: of complete sessions in the last
   * 30 days, how many have a `session_outcomes` row.
   */
  outcomesRecorded: {
    completeSessions30d: number;
    sessionsWithOutcome30d: number;
    rate: number;
  };
}

export async function getEngagementMetrics(now: Date = new Date()): Promise<EngagementMetrics> {
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [completenessRow, rebuildsRow, outcomesRow] = await Promise.all([
    db.execute(sql<{
      completed: number;
      users: number;
    }>`
      WITH has_project AS (
        SELECT DISTINCT user_id FROM projects
      ),
      has_story AS (
        SELECT DISTINCT user_id FROM stories
      ),
      per_user AS (
        SELECT
          u.id,
          -- "Section complete" booleans, cast to int and summed.
          -- Uses aggregated CTEs instead of correlated subqueries to avoid
          -- O(n) per-user scans across projects and stories tables.
          (CASE WHEN p.professional_summary IS NOT NULL OR p.resume_saved_at IS NOT NULL
                THEN 1 ELSE 0 END) +
          (CASE WHEN hp.user_id IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN hs.user_id IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN p.levels IS NOT NULL AND jsonb_array_length(p.levels) > 0
                THEN 1 ELSE 0 END) AS completed
        FROM users u
        LEFT JOIN user_profiles p ON p.user_id = u.id
        LEFT JOIN has_project hp ON hp.user_id = u.id
        LEFT JOIN has_story hs ON hs.user_id = u.id
        WHERE u.deleted_at IS NULL
      )
      SELECT completed::int AS completed, count(*)::int AS users
      FROM per_user
      GROUP BY completed
      ORDER BY completed ASC
    `),
    db.execute(sql<{
      active_users: number;
      rebuild_users: number;
    }>`
      SELECT
        (SELECT count(DISTINCT s.user_id)::int
          FROM interview_sessions s
          WHERE s.state = 'complete'
            AND s.deleted_at IS NULL
            AND s.created_at >= ${since30d.toISOString()}::timestamptz
        ) AS active_users,
        (SELECT count(DISTINCT user_id)::int
          FROM story_rebuilds
        ) AS rebuild_users
    `),
    db.execute(sql<{
      complete_sessions: number;
      sessions_with_outcome: number;
    }>`
      SELECT
        (SELECT count(*)::int
          FROM interview_sessions
          WHERE state = 'complete'
            AND deleted_at IS NULL
            AND created_at >= ${since30d.toISOString()}::timestamptz
        ) AS complete_sessions,
        (SELECT count(DISTINCT o.session_id)::int
          FROM session_outcomes o
          JOIN interview_sessions s ON s.id = o.session_id
          WHERE s.state = 'complete'
            AND s.deleted_at IS NULL
            AND s.created_at >= ${since30d.toISOString()}::timestamptz
        ) AS sessions_with_outcome
    `),
  ]);

  // Pad missing completeness buckets so the page always renders
  // a 0..4 bar chart (empty buckets read as zero rather than
  // missing).
  const seenBuckets =
    (completenessRow as unknown as { rows: Array<{ completed: number; users: number | string }> })
      .rows ?? [];
  const byBucket = new Map<number, number>();
  for (const row of seenBuckets) byBucket.set(Number(row.completed), Number(row.users));
  const profileCompleteness: Array<{ completed: number; users: number }> = [];
  for (let i = 0; i <= 4; i += 1) {
    profileCompleteness.push({ completed: i, users: byBucket.get(i) ?? 0 });
  }

  const rebuildRow =
    (rebuildsRow as unknown as { rows: Array<{ active_users: number | string; rebuild_users: number | string }> })
      .rows?.[0] ?? null;
  const activeUsers30d = Number(rebuildRow?.active_users ?? 0);
  const rebuildUsersEver = Number(rebuildRow?.rebuild_users ?? 0);

  const outcomesRowData =
    (outcomesRow as unknown as { rows: Array<{ complete_sessions: number | string; sessions_with_outcome: number | string }> })
      .rows?.[0] ?? null;
  const completeSessions30d = Number(outcomesRowData?.complete_sessions ?? 0);
  const sessionsWithOutcome30d = Number(outcomesRowData?.sessions_with_outcome ?? 0);

  return {
    profileCompleteness,
    rebuildAdoption: {
      activeUsers30d,
      rebuildUsersEver,
      rate: activeUsers30d === 0 ? 0 : Math.min(1, rebuildUsersEver / activeUsers30d),
    },
    outcomesRecorded: {
      completeSessions30d,
      sessionsWithOutcome30d,
      rate:
        completeSessions30d === 0
          ? 0
          : sessionsWithOutcome30d / completeSessions30d,
    },
  };
}

// ─── InterviewReplay'ed read opening variety ───────────────────────────────

export interface AiReadMetrics {
  /**
   * Number of complete sessions in the last 30 days (denominator for
   * retry and persistence rates).
   */
  completeSessions30d: number;

  /**
   * Reports that triggered a formulaic-opening retry in the last 30
   * days (audit event `analysis.formulaic_opening_retry`).
   */
  formulaicRetries30d: number;

  /**
   * Reports where the formulaic opening persisted after the retry in
   * the last 30 days (audit event `analysis.formulaic_opening_persisted`).
   */
  formulaicPersisted30d: number;

  /** % of sessions that triggered a retry; 0 when no sessions ran. */
  retryRate30d: number;

  /** % of retried sessions where the formulaic opener persisted. */
  persistenceRate30d: number;

  /**
   * Top 5 formulaic opening patterns observed (first 3 words of each
   * first-attempt opening), ordered by frequency descending.
   */
  topOpeningPatterns: Array<{ pattern: string; count: number }>;
}

export async function getAiReadMetrics(
  now: Date = new Date(),
): Promise<AiReadMetrics> {
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Run both queries in parallel — previously sequential, which doubled latency.
  const [result, patternsResult] = await Promise.all([
    db.execute(sql<{
      complete_sessions: number;
      formulaic_retries: number;
      formulaic_persisted: number;
    }>`
      SELECT
        (SELECT count(*)::int
          FROM interview_sessions
          WHERE deleted_at IS NULL
            AND state = 'complete'
            AND created_at >= ${since30d.toISOString()}::timestamptz) AS complete_sessions,
        (SELECT count(*)::int
          FROM audit_log
          WHERE event_type = 'analysis.formulaic_opening_retry'
            AND created_at >= ${since30d.toISOString()}::timestamptz) AS formulaic_retries,
        (SELECT count(*)::int
          FROM audit_log
          WHERE event_type = 'analysis.formulaic_opening_persisted'
            AND created_at >= ${since30d.toISOString()}::timestamptz) AS formulaic_persisted
    `),
    db.execute(sql<{
      pattern: string;
      n: number;
    }>`
      SELECT
        CONCAT(
          split_part(event_data->>'first_attempt_opening', ' ', 1), ' ',
          split_part(event_data->>'first_attempt_opening', ' ', 2), ' ',
          split_part(event_data->>'first_attempt_opening', ' ', 3)
        ) AS pattern,
        count(*)::int AS n
      FROM audit_log
      WHERE event_type = 'analysis.formulaic_opening_retry'
        AND created_at >= ${since30d.toISOString()}::timestamptz
        AND event_data->>'first_attempt_opening' IS NOT NULL
      GROUP BY pattern
      ORDER BY n DESC
      LIMIT 5
    `),
  ]);

  const row =
    (
      result as unknown as {
        rows: Array<{
          complete_sessions: number | string;
          formulaic_retries: number | string;
          formulaic_persisted: number | string;
        }>;
      }
    ).rows?.[0] ?? null;

  const completeSessions30d = Number(row?.complete_sessions ?? 0);
  const formulaicRetries30d = Number(row?.formulaic_retries ?? 0);
  const formulaicPersisted30d = Number(row?.formulaic_persisted ?? 0);

  const topOpeningPatterns = (
    (
      patternsResult as unknown as {
        rows: Array<{ pattern: string; n: number | string }>;
      }
    ).rows ?? []
  ).map((r) => ({ pattern: r.pattern?.trim() ?? "", count: Number(r.n) }));

  return {
    completeSessions30d,
    formulaicRetries30d,
    formulaicPersisted30d,
    retryRate30d:
      completeSessions30d === 0 ? 0 : formulaicRetries30d / completeSessions30d,
    persistenceRate30d:
      formulaicRetries30d === 0
        ? 0
        : formulaicPersisted30d / formulaicRetries30d,
    topOpeningPatterns,
  };
}

// ─── Summary differentiation ──────────────────────────────────────

export interface SummaryDifferentiationMetrics {
  /** Number of complete sessions in the last 30 days (denominator). */
  completeSessions30d: number;

  /**
   * Reports that triggered a high-overlap retry (>0.35) in the last
   * 30 days. Audit event: `analysis.high_summary_overlap_retry`.
   */
  highOverlapRetries30d: number;

  /**
   * Reports where the final overlap was in the warning band (>0.20)
   * in the last 30 days. Audit event: `analysis.summary_overlap_warning`.
   * Includes sessions that retried but are still above the threshold.
   */
  warningLevelOverlaps30d: number;

  /** % of sessions that triggered a high-overlap retry; 0 when no sessions. */
  retryRate30d: number;

  /**
   * % of sessions where the final overlap was warning-level (>0.20),
   * whether or not a retry occurred. 0 when no sessions.
   */
  warningRate30d: number;
}

export async function getSummaryDifferentiationMetrics(
  now: Date = new Date(),
): Promise<SummaryDifferentiationMetrics> {
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const result = await db.execute(sql<{
    complete_sessions: number;
    high_overlap_retries: number;
    warning_level_overlaps: number;
  }>`
    SELECT
      (SELECT count(*)::int
        FROM interview_sessions
        WHERE deleted_at IS NULL
          AND state = 'complete'
          AND created_at >= ${since30d.toISOString()}::timestamptz) AS complete_sessions,
      (SELECT count(*)::int
        FROM audit_log
        WHERE event_type = 'analysis.high_summary_overlap_retry'
          AND created_at >= ${since30d.toISOString()}::timestamptz) AS high_overlap_retries,
      (SELECT count(*)::int
        FROM audit_log
        WHERE event_type = 'analysis.summary_overlap_warning'
          AND created_at >= ${since30d.toISOString()}::timestamptz) AS warning_level_overlaps
  `);

  const row =
    (result as unknown as {
      rows: Array<{
        complete_sessions: number | string;
        high_overlap_retries: number | string;
        warning_level_overlaps: number | string;
      }>;
    }).rows?.[0] ?? null;

  const completeSessions30d = Number(row?.complete_sessions ?? 0);
  const highOverlapRetries30d = Number(row?.high_overlap_retries ?? 0);
  const warningLevelOverlaps30d = Number(row?.warning_level_overlaps ?? 0);

  return {
    completeSessions30d,
    highOverlapRetries30d,
    warningLevelOverlaps30d,
    retryRate30d:
      completeSessions30d === 0 ? 0 : highOverlapRetries30d / completeSessions30d,
    warningRate30d:
      completeSessions30d === 0 ? 0 : warningLevelOverlaps30d / completeSessions30d,
  };
}

// ─── Round-type detail overlap ─────────────────────────────────────

export interface RoundDetailOverlapMetrics {
  /** Number of complete sessions in the last 30 days (denominator). */
  completeSessions30d: number;

  /**
   * Reports where round-type detail overlapped with Strengths (>0.25
   * overlap coefficient) in the last 30 days.
   * Audit event: `analysis.round_detail_overlap` with an `issues`
   * array containing a `round_detail_overlaps_strengths` entry.
   */
  strengthsOverlapCount30d: number;

  /**
   * Reports where round-type detail overlapped with Improvements
   * (>0.25 overlap coefficient) in the last 30 days.
   * Audit event: `analysis.round_detail_overlap` with an `issues`
   * array containing a `round_detail_overlaps_improvements` entry.
   */
  improvementsOverlapCount30d: number;

  /**
   * Reports where any round-type detail field contained prescriptive
   * language ("you should", "try to", "could improve") in the last
   * 30 days. Audit event: `analysis.round_detail_prescriptive_language`.
   */
  prescriptiveLanguageCount30d: number;

  /** % of sessions where round detail overlapped Strengths; 0 when no sessions. */
  strengthsOverlapRate30d: number;

  /** % of sessions where round detail overlapped Improvements; 0 when no sessions. */
  improvementsOverlapRate30d: number;

  /** % of sessions with prescriptive language in round detail; 0 when no sessions. */
  prescriptiveLanguageRate30d: number;
}

export async function getRoundDetailOverlapMetrics(
  now: Date = new Date(),
): Promise<RoundDetailOverlapMetrics> {
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const result = await db.execute(sql<{
    complete_sessions: number;
    strengths_overlaps: number;
    improvements_overlaps: number;
    prescriptive_language: number;
  }>`
    SELECT
      (SELECT count(*)::int
        FROM interview_sessions
        WHERE deleted_at IS NULL
          AND state = 'complete'
          AND created_at >= ${since30d.toISOString()}::timestamptz) AS complete_sessions,
      (SELECT count(*)::int
        FROM audit_log
        WHERE event_type = 'analysis.round_detail_overlap'
          AND event_data::text LIKE '%round_detail_overlaps_strengths%'
          AND created_at >= ${since30d.toISOString()}::timestamptz) AS strengths_overlaps,
      (SELECT count(*)::int
        FROM audit_log
        WHERE event_type = 'analysis.round_detail_overlap'
          AND event_data::text LIKE '%round_detail_overlaps_improvements%'
          AND created_at >= ${since30d.toISOString()}::timestamptz) AS improvements_overlaps,
      (SELECT count(*)::int
        FROM audit_log
        WHERE event_type = 'analysis.round_detail_prescriptive_language'
          AND created_at >= ${since30d.toISOString()}::timestamptz) AS prescriptive_language
  `);

  const row =
    (result as unknown as {
      rows: Array<{
        complete_sessions: number | string;
        strengths_overlaps: number | string;
        improvements_overlaps: number | string;
        prescriptive_language: number | string;
      }>;
    }).rows?.[0] ?? null;

  const completeSessions30d = Number(row?.complete_sessions ?? 0);
  const strengthsOverlapCount30d = Number(row?.strengths_overlaps ?? 0);
  const improvementsOverlapCount30d = Number(row?.improvements_overlaps ?? 0);
  const prescriptiveLanguageCount30d = Number(row?.prescriptive_language ?? 0);

  return {
    completeSessions30d,
    strengthsOverlapCount30d,
    improvementsOverlapCount30d,
    prescriptiveLanguageCount30d,
    strengthsOverlapRate30d:
      completeSessions30d === 0 ? 0 : strengthsOverlapCount30d / completeSessions30d,
    improvementsOverlapRate30d:
      completeSessions30d === 0 ? 0 : improvementsOverlapCount30d / completeSessions30d,
    prescriptiveLanguageRate30d:
      completeSessions30d === 0 ? 0 : prescriptiveLanguageCount30d / completeSessions30d,
  };
}

// ─── Page timing ─────────────────────────────────────────────────

export interface PageTimingEntry {
  pathname: string;
  /** Average Navigation Timing loadEventEnd in ms (initial hard-nav only). */
  avgLoadMs: number;
  /** 95th-percentile load time in ms. */
  p95LoadMs: number;
  /** Average visible time spent on the page in ms. */
  avgTimeSpentMs: number;
  /** Number of data points in the window. */
  samples: number;
}

export interface PageTimingMetrics {
  /** Top pages by avg load time (desc), last 7 days — max 15 rows. */
  byLoadTime: PageTimingEntry[];
  /** Top pages by avg time spent (desc), last 7 days — max 15 rows. */
  byTimeSpent: PageTimingEntry[];
  /** Overall avg load ms across all pages/users, last 7 days. */
  overallAvgLoadMs: number | null;
  /** Overall avg time spent ms across all pages/users, last 7 days. */
  overallAvgTimeSpentMs: number | null;
}

export async function getPageTimingMetrics(now: Date = new Date()): Promise<PageTimingMetrics> {
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [pageRows, overallRow] = await Promise.all([
    db.execute(sql`
      SELECT
        event_data->>'pathname' AS pathname,
        AVG((event_data->>'load_ms')::float)::float AS avg_load_ms,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY (event_data->>'load_ms')::float
        ) AS p95_load_ms,
        AVG((event_data->>'time_spent_ms')::float)::float AS avg_time_spent_ms,
        count(*)::int AS samples
      FROM audit_log
      WHERE event_type = 'page.timing'
        AND created_at >= ${since7d.toISOString()}::timestamptz
        AND event_data->>'pathname' IS NOT NULL
      GROUP BY event_data->>'pathname'
      HAVING count(*) >= 3
      ORDER BY avg_load_ms DESC NULLS LAST
      LIMIT 30
    `),
    db.execute(sql`
      SELECT
        AVG((event_data->>'load_ms')::float)::float AS overall_avg_load_ms,
        AVG((event_data->>'time_spent_ms')::float)::float AS overall_avg_time_spent_ms
      FROM audit_log
      WHERE event_type = 'page.timing'
        AND created_at >= ${since7d.toISOString()}::timestamptz
        AND event_data->>'load_ms' IS NOT NULL
    `),
  ]);

  type PageRow = {
    pathname: string;
    avg_load_ms: string | number | null;
    p95_load_ms: string | number | null;
    avg_time_spent_ms: string | number | null;
    samples: string | number;
  };
  type OverallRow = {
    overall_avg_load_ms: string | number | null;
    overall_avg_time_spent_ms: string | number | null;
  };

  const rows = ((pageRows as unknown as { rows: PageRow[] }).rows ?? []).map(
    (r) => ({
      pathname: r.pathname,
      avgLoadMs: r.avg_load_ms == null ? 0 : Math.round(Number(r.avg_load_ms)),
      p95LoadMs: r.p95_load_ms == null ? 0 : Math.round(Number(r.p95_load_ms)),
      avgTimeSpentMs:
        r.avg_time_spent_ms == null ? 0 : Math.round(Number(r.avg_time_spent_ms)),
      samples: Number(r.samples),
    }),
  );

  const byLoadTime = [...rows]
    .sort((a, b) => b.avgLoadMs - a.avgLoadMs)
    .slice(0, 15);
  const byTimeSpent = [...rows]
    .sort((a, b) => b.avgTimeSpentMs - a.avgTimeSpentMs)
    .slice(0, 15);

  const ov =
    ((overallRow as unknown as { rows: OverallRow[] }).rows ?? [])[0] ?? null;

  return {
    byLoadTime,
    byTimeSpent,
    overallAvgLoadMs:
      ov?.overall_avg_load_ms == null
        ? null
        : Math.round(Number(ov.overall_avg_load_ms)),
    overallAvgTimeSpentMs:
      ov?.overall_avg_time_spent_ms == null
        ? null
        : Math.round(Number(ov.overall_avg_time_spent_ms)),
  };
}

// ─── Aggregated snapshot ──────────────────────────────────────────

/** Per-query timing breakdown (ms). Exposed on the health page header
 *  so the admin can see which DB query is the bottleneck. */
export interface QueryTimings {
  ai: number;
  infra: number;
  geo: number;
  engagement: number;
  aiRead: number;
  summaryDifferentiation: number;
  roundDetailOverlap: number;
  pageTiming: number;
  /** Wall-clock total including Promise.all coordination overhead. */
  total: number;
}

export interface HealthSnapshot {
  generatedAt: string;
  /** DB query timing breakdown in ms — use to spot the slow query. */
  queryMs: QueryTimings;
  ai: AiQualityMetrics;
  infra: InfraMetrics;
  geo: GeoMetrics;
  engagement: EngagementMetrics;
  aiRead: AiReadMetrics;
  summaryDifferentiation: SummaryDifferentiationMetrics;
  roundDetailOverlap: RoundDetailOverlapMetrics;
  pageTiming: PageTimingMetrics;
}

export async function getHealthSnapshot(now: Date = new Date()): Promise<HealthSnapshot> {
  const snapshotStart = Date.now();

  const [
    { result: ai, ms: aiMs },
    { result: infra, ms: infraMs },
    { result: geo, ms: geoMs },
    { result: engagement, ms: engagementMs },
    { result: aiRead, ms: aiReadMs },
    { result: summaryDifferentiation, ms: summaryDifferentiationMs },
    { result: roundDetailOverlap, ms: roundDetailOverlapMs },
    { result: pageTiming, ms: pageTimingMs },
  ] = await Promise.all([
    timed(() => getAiQualityMetrics(now)),
    timed(() => getInfraMetrics(now)),
    timed(() => getGeoMetrics(now)),
    timed(() => getEngagementMetrics(now)),
    timed(() => getAiReadMetrics(now)),
    timed(() => getSummaryDifferentiationMetrics(now)),
    timed(() => getRoundDetailOverlapMetrics(now)),
    timed(() => getPageTimingMetrics(now)),
  ]);

  return {
    generatedAt: now.toISOString(),
    queryMs: {
      ai: aiMs,
      infra: infraMs,
      geo: geoMs,
      engagement: engagementMs,
      aiRead: aiReadMs,
      summaryDifferentiation: summaryDifferentiationMs,
      roundDetailOverlap: roundDetailOverlapMs,
      pageTiming: pageTimingMs,
      total: Date.now() - snapshotStart,
    },
    ai,
    infra,
    geo,
    engagement,
    aiRead,
    summaryDifferentiation,
    roundDetailOverlap,
    pageTiming,
  };
}

// ─── helpers ───────────────────────────────────────────────────────

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

function toIsoDate(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v);
  return d.toISOString().slice(0, 10);
}
