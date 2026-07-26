import type { Metadata } from "next";

import { getAdminUser } from "@/lib/admin/auth";
import { getOpsSnapshot } from "@/lib/admin/ops-snapshot";
import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { Funnel } from "@/components/admin/ops/funnel";
import { HealthAlerts } from "@/components/admin/ops/health-alerts";
import { MetricCard } from "@/components/admin/ops/metric-card";
import { RefreshButton } from "@/components/admin/ops/refresh-button";
import { TrendChart } from "@/components/admin/ops/trend-chart";

/**
 * Daily Ops dashboard — the single most important admin surface.
 *
 * All data is fetched server-side in one `getOpsSnapshot()` call
 * (six parallel queries inside). No client loading states; per the
 * spec, the admin tool doesn't need to optimize for a flicker.
 *
 * Page sections (top to bottom):
 *   A. Header strip            — title + date + refresh button
 *   B. Today metrics           — five-card grid with yesterday delta
 *   C. Last 7 days trend       — chart.js line chart, three series
 *   D. Conversion funnel       — four cards, 30-day cohort
 *   E. Money in, money out     — revenue + variable cost + gross margin
 *   F. Health alerts           — ordered critical → warning → info
 *
 * Cache control: server-side `Cache-Control: no-store` on the page
 * itself (Next 15 RSCs are fresh on every navigation by default;
 * we keep that posture for admin surfaces). The `/api/admin/ops`
 * endpoint is separately cached for 60s for the refresh-button /
 * scripted-consumer paths.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Daily ops · InterviewReplay admin",
};

export default async function AdminOpsPage() {
  // The (admin) layout already gated this render on is_admin=true,
  // but we re-resolve the user here to attribute the analytics event
  // by `distinctId`. `getAdminUser` is wrapped in `react.cache`
  // (see `lib/admin/auth.ts`) so this is a zero-cost hit — the
  // layout's call already populated the per-request cache.
  const admin = await getAdminUser();
  const snapshot = await getOpsSnapshot();
  const { today, yesterday, trend, funnel, revenue_and_cost, alerts } = snapshot;

  if (admin) {
    // Fire-and-forget analytics event.
    trackServerEvent({
      distinctId: admin.id,
      event: ANALYTICS_EVENTS.adminOpsViewed,
      properties: {
        active_alerts_count: alerts.length,
      },
    });
  }

  // Friendly date for the subtitle. "Sunday, 17 May 2026" reads
  // unambiguously across locales without needing the year on the
  // tile labels.
  const todayLabel = new Date(snapshot.today_date + "T00:00:00Z").toLocaleDateString(
    undefined,
    { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" },
  );

  // 7-day labels for the trend section. The first and last entries
  // bracket the data; e.g. "11 May – 17 May".
  const trendStart = trend[0]?.date;
  const trendEnd = trend[trend.length - 1]?.date;
  const trendRangeLabel =
    trendStart && trendEnd
      ? `${shortDate(trendStart)} – ${shortDate(trendEnd)}`
      : "";

  const packs = revenue_and_cost.packs_sold;
  const avgPerPack =
    packs > 0 ? Math.round(revenue_and_cost.revenue_inr / packs) : 0;
  const sessionsForCost =
    Math.round(revenue_and_cost.variable_cost_inr_estimate / 50);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* A. Header strip */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1
            className="text-2xl font-semibold"
            style={{ color: "var(--color-text-primary)" }}
          >
            InterviewReplay admin
          </h1>
          <p
            className="mt-1 text-sm"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Daily ops · {todayLabel}
          </p>
        </div>
        <RefreshButton generatedAt={snapshot.generated_at} />
      </header>

      {/* B. Today metrics */}
      <SectionLabel>Today</SectionLabel>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
        <MetricCard
          label="Signups"
          value={today.new_signups.toLocaleString("en-IN")}
          delta={today.new_signups - yesterday.new_signups}
        />
        <MetricCard
          label="New paying"
          value={today.new_paying_users.toLocaleString("en-IN")}
          delta={today.new_paying_users - yesterday.new_paying_users}
        />
        <MetricCard
          label="Revenue"
          value={`₹${today.revenue_inr.toLocaleString("en-IN")}`}
          delta={today.revenue_inr - yesterday.revenue_inr}
          deltaIsCurrency
        />
        <MetricCard
          label="Active users"
          value={today.active_users.toLocaleString("en-IN")}
          delta={today.active_users - yesterday.active_users}
        />
        <MetricCard
          label="Sessions"
          value={today.sessions_analyzed.toLocaleString("en-IN")}
          delta={today.sessions_analyzed - yesterday.sessions_analyzed}
        />
      </div>

      {/* C. 7-day trend */}
      <div className="mt-10 flex items-baseline justify-between">
        <h2
          className="text-base font-semibold"
          style={{ color: "var(--color-text-primary)" }}
        >
          Last 7 days
        </h2>
        <span
          className="text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {trendRangeLabel}
        </span>
      </div>
      <TrendLegend />
      <div className="mt-2">
        <TrendChart data={trend} />
      </div>

      {/* D. Funnel */}
      <div className="mt-10 flex items-baseline justify-between">
        <h2
          className="text-base font-semibold"
          style={{ color: "var(--color-text-primary)" }}
        >
          Conversion funnel
        </h2>
        <span
          className="text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Last 30 days
        </span>
      </div>
      <div className="mt-3">
        <Funnel data={funnel} />
      </div>

      {/* E. Money in, money out */}
      <div className="mt-10 flex items-baseline justify-between">
        <h2
          className="text-base font-semibold"
          style={{ color: "var(--color-text-primary)" }}
        >
          Money in, money out
        </h2>
        <span
          className="text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Last 30 days
        </span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div
          className="rounded-md p-4"
          style={{
            background: "var(--color-bg-secondary)",
            borderRadius: "var(--border-radius-md, 8px)",
          }}
        >
          <div className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
            Revenue
          </div>
          <div
            className="mt-1 text-3xl font-semibold tabular-nums"
            style={{ color: "var(--color-success)" }}
          >
            ₹{revenue_and_cost.revenue_inr.toLocaleString("en-IN")}
          </div>
          <div
            className="mt-1 text-xs"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {packs} pack{packs === 1 ? "" : "s"} sold
            {packs > 0 && (
              <>
                {" "}· avg ₹{avgPerPack.toLocaleString("en-IN")} per pack
              </>
            )}
          </div>
        </div>
        <div
          className="rounded-md p-4"
          style={{
            background: "var(--color-bg-secondary)",
            borderRadius: "var(--border-radius-md, 8px)",
          }}
        >
          <div className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
            Variable cost est.
          </div>
          <div
            className="mt-1 text-3xl font-semibold tabular-nums"
            style={{ color: "var(--color-danger)" }}
          >
            ₹{revenue_and_cost.variable_cost_inr_estimate.toLocaleString("en-IN")}
          </div>
          <div
            className="mt-1 text-xs"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {sessionsForCost} session{sessionsForCost === 1 ? "" : "s"} × ₹50 avg
          </div>
        </div>
      </div>
      <p
        className="mt-2 text-xs italic"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Gross margin: ₹
        {revenue_and_cost.gross_margin_inr.toLocaleString("en-IN")} (
        {revenue_and_cost.gross_margin_pct}%). Fixed infra not included.
      </p>

      {/* F. Health alerts */}
      <div className="mt-10">
        <h2
          className="text-base font-semibold"
          style={{ color: "var(--color-text-primary)" }}
        >
          Health alerts
        </h2>
        <div className="mt-3">
          <HealthAlerts alerts={alerts} />
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mt-8 text-xs font-medium uppercase tracking-wide"
      style={{ color: "var(--color-text-tertiary)" }}
    >
      {children}
    </div>
  );
}

function TrendLegend() {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
      <LegendPill color="#378ADD" label="Signups" />
      <LegendPill color="#1D9E75" label="New paying" />
      <LegendPill color="#7F77DD" label="Sessions" />
    </div>
  );
}

function LegendPill({ color, label }: { color: string; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{ color: "var(--color-text-secondary)" }}
    >
      <span
        aria-hidden
        className="inline-block size-2 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function shortDate(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
