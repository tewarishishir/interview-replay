import "server-only";

import { sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * Aggregate geography stats for the past N days. Designed to be
 * called from the admin endpoint and the weekly cron with the same
 * shape, so both render identically in an email and in JSON.
 *
 * Columns aggregated:
 *   - signups by `users.signup_country_code`
 *   - paying users (distinct users with a `succeeded` credit purchase)
 *     by `users.signup_country_code`
 *   - sessions created by `users.signup_country_code`
 *
 * `null` country codes are bucketed into "UNKNOWN" so they show up in
 * the report rather than silently disappearing.
 */
export interface GeographyReport {
  windowDays: number;
  signupsByCountry: Array<{ country: string; count: number }>;
  payingUsersByCountry: Array<{ country: string; count: number }>;
  sessionsByCountry: Array<{ country: string; count: number }>;
  /**
   * Threshold flag: non-IN paying users as a percentage of total
   * paying users. The runbook says >5% triggers manual investigation.
   */
  nonIndiaPayingPct: number;
  /**
   * Computed snapshot time (UTC). Stamped here so the email body
   * shows a single "as of …" timestamp regardless of report-rendering
   * latency.
   */
  asOf: Date;
}

const UNKNOWN = "UNKNOWN";

export async function computeGeographyReport(args: {
  windowDays?: number;
}): Promise<GeographyReport> {
  const windowDays = Math.max(1, Math.min(90, args.windowDays ?? 30));

  const [signupsRows, payingRows, sessionRows] = await Promise.all([
    db.execute<{ country: string | null; n: number }>(sql`
      SELECT signup_country_code AS country, COUNT(*)::int AS n
      FROM ${schema.users}
      WHERE created_at >= NOW() - (${windowDays}::int * INTERVAL '1 day')
      GROUP BY signup_country_code
      ORDER BY n DESC
    `),
    db.execute<{ country: string | null; n: number }>(sql`
      SELECT u.signup_country_code AS country, COUNT(DISTINCT u.id)::int AS n
      FROM ${schema.users} u
      JOIN ${schema.creditPurchases} p ON p.user_id = u.id
      WHERE p.status = 'succeeded'
        AND p.created_at >= NOW() - (${windowDays}::int * INTERVAL '1 day')
      GROUP BY u.signup_country_code
      ORDER BY n DESC
    `),
    db.execute<{ country: string | null; n: number }>(sql`
      SELECT u.signup_country_code AS country, COUNT(*)::int AS n
      FROM ${schema.users} u
      JOIN ${schema.interviewSessions} s ON s.user_id = u.id
      WHERE s.created_at >= NOW() - (${windowDays}::int * INTERVAL '1 day')
      GROUP BY u.signup_country_code
      ORDER BY n DESC
    `),
  ]);

  const normalize = (
    rows: Array<{ country: string | null; n: number }>,
  ): Array<{ country: string; count: number }> =>
    rows.map((row) => ({ country: row.country ?? UNKNOWN, count: row.n }));

  const paying = normalize(payingRows.rows);
  const totalPaying = paying.reduce((s, r) => s + r.count, 0);
  const nonIndiaPaying = paying
    .filter((r) => r.country !== "IN" && r.country !== UNKNOWN)
    .reduce((s, r) => s + r.count, 0);

  return {
    windowDays,
    signupsByCountry: normalize(signupsRows.rows),
    payingUsersByCountry: paying,
    sessionsByCountry: normalize(sessionRows.rows),
    nonIndiaPayingPct:
      totalPaying === 0 ? 0 : (nonIndiaPaying / totalPaying) * 100,
    asOf: new Date(),
  };
}

/**
 * Render the report as a short HTML email body. Plain enough that
 * even GMail clipping doesn't lose the per-country tables; the
 * weekly cron emails it to the operator distro list.
 */
export function renderGeographyReportHtml(report: GeographyReport): string {
  const tableFor = (
    title: string,
    rows: Array<{ country: string; count: number }>,
  ): string => {
    const body = rows
      .map(
        (r) =>
          `<tr><td style="padding:4px 12px 4px 0;">${r.country}</td><td style="padding:4px 0;text-align:right;">${r.count}</td></tr>`,
      )
      .join("");
    return `<h3 style="margin:16px 0 4px;font-size:14px;font-weight:600;">${title}</h3>
            <table style="font-size:13px;"><tbody>${body || "<tr><td>(no data)</td></tr>"}</tbody></table>`;
  };
  return [
    `<p style="font-size:13px;color:#374151;">As of ${report.asOf.toISOString()}, last ${report.windowDays} days.</p>`,
    `<p style="font-size:13px;color:#374151;">Non-India paying users: <strong>${report.nonIndiaPayingPct.toFixed(2)}%</strong> ${report.nonIndiaPayingPct > 5 ? "<span style=\"color:#b91c1c;\">(over 5% threshold — investigate)</span>" : ""}</p>`,
    tableFor("Signups by country", report.signupsByCountry),
    tableFor("Paying users by country", report.payingUsersByCountry),
    tableFor("Sessions by country", report.sessionsByCountry),
  ].join("\n");
}
