import "server-only";

import {
  getDailyMetrics,
  getFunnel,
  getHealthAlerts,
  getRevenueAndCost,
  getWeeklyTrend,
  type DailyMetrics,
  type FunnelMetrics,
  type HealthAlert,
  type RevenueAndCost,
  type WeeklyTrendEntry,
} from "./queries";

/**
 * Top-level "everything the Ops dashboard renders" aggregate.
 *
 * Two paths consume this:
 *   - the /admin/ops page (server component, no caching — the
 *     admin's full reload always sees fresh data).
 *   - the /api/admin/ops route (60s cached — the refresh button
 *     uses this to swap in fresh JSON without re-running the
 *     full page render).
 *
 * Both queries fan out in parallel — `Promise.all` keeps the page-
 * level latency at max(individual query) rather than sum.
 *
 * `today` and `yesterday` are computed once at the top so a
 * caller can pin a specific "now" for tests without per-query
 * threading. The midnight rollover is UTC (see the dayBounds note
 * in queries.ts).
 */
export interface OpsSnapshot {
  /** ISO timestamp of when this snapshot was computed. */
  generated_at: string;
  today_date: string;
  today: DailyMetrics;
  yesterday: DailyMetrics;
  trend: WeeklyTrendEntry[];
  funnel: FunnelMetrics;
  revenue_and_cost: RevenueAndCost;
  alerts: HealthAlert[];
}

export async function getOpsSnapshot(now: Date = new Date()): Promise<OpsSnapshot> {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [today, yest, trend, funnel, revAndCost, alerts] = await Promise.all([
    getDailyMetrics(now),
    getDailyMetrics(yesterday),
    getWeeklyTrend(now),
    getFunnel(thirtyDaysAgo, now),
    getRevenueAndCost(thirtyDaysAgo, now),
    getHealthAlerts(now),
  ]);

  return {
    generated_at: now.toISOString(),
    today_date: now.toISOString().slice(0, 10),
    today,
    yesterday: yest,
    trend,
    funnel,
    revenue_and_cost: revAndCost,
    alerts,
  };
}
