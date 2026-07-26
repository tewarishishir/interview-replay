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
 *   - sessions created by `users.signup_country_code`
 *
 * `null` country codes are bucketed into "UNKNOWN" so they show up in
 * the report rather than silently disappearing.
 */
export interface GeographyReport {
  windowDays: number;
  signupsByCountry: Array<{ country: string; count: number }>;
  sessionsByCountry: Array<{ country: string; count: number }>;
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

  const [signupsRows, sessionRows] = await Promise.all([
    db.execute<{ country: string | null; n: number }>(sql`
      SELECT signup_country_code AS country, COUNT(*)::int AS n
      FROM ${schema.users}
      WHERE created_at >= NOW() - (${windowDays}::int * INTERVAL '1 day')
      GROUP BY signup_country_code
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

  return {
    windowDays,
    signupsByCountry: normalize(signupsRows.rows),
    sessionsByCountry: normalize(sessionRows.rows),
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
    tableFor("Signups by country", report.signupsByCountry),
    tableFor("Sessions by country", report.sessionsByCountry),
  ].join("\n");
}
