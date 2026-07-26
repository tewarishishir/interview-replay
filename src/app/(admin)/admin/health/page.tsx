import type { Metadata } from "next";
import { LocalTime } from "@/components/ui/local-time";

import { getAdminUser } from "@/lib/admin/auth";
import {
  getHealthSnapshot,
  type AiQualityMetrics,
  type AiReadMetrics,
  type EngagementMetrics,
  type GeoMetrics,
  type InfraMetrics,
  type PageTimingMetrics,
  type QueryTimings,
  type RoundDetailOverlapMetrics,
  type SummaryDifferentiationMetrics,
} from "@/lib/admin/health-queries";
import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { CountryBarChart } from "@/components/admin/health/country-bar-chart";
import { SessionsTrendChart } from "@/components/admin/health/sessions-trend-chart";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Product health · InterviewReplay admin",
};

export default async function AdminHealthPage() {
  const [admin, snapshot] = await Promise.all([
    getAdminUser(),
    getHealthSnapshot(),
  ]);

  if (admin) {
    trackServerEvent({
      distinctId: admin.id,
      event: ANALYTICS_EVENTS.adminHealthViewed,
      properties: {
        signups_30d: snapshot.geo.totalSignups30d,
      },
    });
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1
            className="text-2xl font-semibold"
            style={{ color: "var(--color-text-primary)" }}
          >
            Product health
          </h1>
          <p
            className="mt-1 text-sm"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Snapshot at <LocalTime date={new Date(snapshot.generatedAt)} /> — live
            · {snapshot.queryMs.total}ms total DB time
          </p>
        </div>
      </header>

      <div className="mt-6 grid gap-6">
        <QueryTimingSection queryMs={snapshot.queryMs} />
        <PagePerformanceSection pageTiming={snapshot.pageTiming} />
        <AiQualitySection ai={snapshot.ai} />
        <AiReadSection aiRead={snapshot.aiRead} />
        <SummaryDifferentiationSection
          diff={snapshot.summaryDifferentiation}
        />
        <RoundDetailOverlapSection roundDetail={snapshot.roundDetailOverlap} />
        <InfrastructureSection infra={snapshot.infra} />
        <GeoSection geo={snapshot.geo} />
        <EngagementSection engagement={snapshot.engagement} />
      </div>
    </div>
  );
}

// ─── Query timing ─────────────────────────────────────────────────

function QueryTimingSection({ queryMs }: { queryMs: QueryTimings }) {
  const entries: Array<{ label: string; ms: number }> = [
    { label: "AI quality", ms: queryMs.ai },
    { label: "Infrastructure", ms: queryMs.infra },
    { label: "Geography", ms: queryMs.geo },
    { label: "Engagement", ms: queryMs.engagement },
    { label: "AI Read", ms: queryMs.aiRead },
    { label: "Summary diff.", ms: queryMs.summaryDifferentiation },
    { label: "Round detail", ms: queryMs.roundDetailOverlap },
    { label: "Page timing", ms: queryMs.pageTiming },
  ].sort((a, b) => b.ms - a.ms);

  const slowest = entries[0]?.ms ?? 0;

  return (
    <Section
      title="Server-side query timing"
      subtitle={`Total: ${queryMs.total}ms — all queries ran in parallel`}
    >
      <div className="grid gap-2">
        {entries.map(({ label, ms }) => {
          const barPct = slowest === 0 ? 0 : (ms / slowest) * 100;
          const tone: "danger" | "warning" | undefined =
            ms >= 1000 ? "danger" : ms >= 400 ? "warning" : undefined;
          const barColor =
            tone === "danger"
              ? "var(--color-danger-text)"
              : tone === "warning"
                ? "var(--color-warning-text)"
                : "var(--color-success)";
          return (
            <div
              key={label}
              className="grid grid-cols-[140px_1fr_70px] items-center gap-3"
            >
              <span
                className="text-xs"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {label}
              </span>
              <div
                className="h-2 overflow-hidden rounded-full"
                style={{ background: "var(--color-bg-secondary)" }}
              >
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${barPct}%`, background: barColor }}
                />
              </div>
              <span
                className="text-right text-xs tabular-nums font-medium"
                style={{
                  color:
                    tone === "danger"
                      ? "var(--color-danger-text)"
                      : tone === "warning"
                        ? "var(--color-warning-text)"
                        : "var(--color-text-secondary)",
                }}
              >
                {ms}ms
              </span>
            </div>
          );
        })}
      </div>
      <p
        className="mt-3 text-xs"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        ≥400ms = warning · ≥1000ms = slow. Bottleneck is the longest bar.
      </p>
    </Section>
  );
}

// ─── Page performance ─────────────────────────────────────────────

function PagePerformanceSection({
  pageTiming,
}: {
  pageTiming: PageTimingMetrics;
}) {
  const hasData =
    pageTiming.byLoadTime.length > 0 || pageTiming.byTimeSpent.length > 0;

  return (
    <Section
      title="Page performance"
      subtitle="Last 7 days · client-measured · min 3 samples per page"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        <Metric
          label="Avg page load time"
          value={
            pageTiming.overallAvgLoadMs == null
              ? "—"
              : formatMs(pageTiming.overallAvgLoadMs)
          }
          sublabel="initial hard-nav · all pages"
          tone={
            pageTiming.overallAvgLoadMs != null &&
            pageTiming.overallAvgLoadMs >= 3000
              ? "danger"
              : pageTiming.overallAvgLoadMs != null &&
                  pageTiming.overallAvgLoadMs >= 1500
                ? "warning"
                : pageTiming.overallAvgLoadMs != null
                  ? "ok"
                  : undefined
          }
        />
        <Metric
          label="Avg time on page"
          value={
            pageTiming.overallAvgTimeSpentMs == null
              ? "—"
              : formatMs(pageTiming.overallAvgTimeSpentMs)
          }
          sublabel="per visit · all pages"
        />
        <Metric
          label="Pages tracked"
          value={String(pageTiming.byLoadTime.length)}
          sublabel="distinct routes with ≥3 samples"
        />
      </div>

      {!hasData && (
        <EmptyState text="No page timing data yet. Data will appear after users visit pages and the tracker sends measurements." />
      )}

      {hasData && (
        <div className="grid gap-8 lg:grid-cols-2">
          {pageTiming.byLoadTime.length > 0 && (
            <div>
              <h3
                className="mb-3 text-xs font-medium uppercase tracking-wide"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Slowest pages by load time (avg)
              </h3>
              <PageTimingTable
                rows={pageTiming.byLoadTime}
                valueKey="load"
              />
            </div>
          )}
          {pageTiming.byTimeSpent.length > 0 && (
            <div>
              <h3
                className="mb-3 text-xs font-medium uppercase tracking-wide"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Most time spent per visit (avg)
              </h3>
              <PageTimingTable
                rows={pageTiming.byTimeSpent}
                valueKey="time_spent"
              />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function PageTimingTable({
  rows,
  valueKey,
}: {
  rows: PageTimingMetrics["byLoadTime"];
  valueKey: "load" | "time_spent";
}) {
  const maxVal =
    valueKey === "load"
      ? Math.max(...rows.map((r) => r.avgLoadMs), 1)
      : Math.max(...rows.map((r) => r.avgTimeSpentMs), 1);

  return (
    <ul className="flex flex-col gap-2">
      {rows.slice(0, 10).map((row) => {
        const val =
          valueKey === "load" ? row.avgLoadMs : row.avgTimeSpentMs;
        const pct = (val / maxVal) * 100;
        const isLoad = valueKey === "load";
        const tone =
          isLoad && val >= 3000
            ? "danger"
            : isLoad && val >= 1500
              ? "warning"
              : undefined;
        const barColor =
          tone === "danger"
            ? "var(--color-danger-text)"
            : tone === "warning"
              ? "var(--color-warning-text)"
              : "var(--color-brand, var(--color-success))";

        return (
          <li key={row.pathname}>
            <div className="flex items-center justify-between mb-0.5">
              <span
                className="max-w-[220px] truncate font-mono text-xs"
                style={{ color: "var(--color-text-primary)" }}
                title={row.pathname}
              >
                {row.pathname}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                {isLoad && (
                  <span
                    className="text-xs tabular-nums"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    p95 {formatMs(row.p95LoadMs)}
                  </span>
                )}
                <span
                  className="text-xs tabular-nums font-medium"
                  style={{
                    color:
                      tone === "danger"
                        ? "var(--color-danger-text)"
                        : tone === "warning"
                          ? "var(--color-warning-text)"
                          : "var(--color-text-secondary)",
                  }}
                >
                  {formatMs(val)}
                </span>
                <span
                  className="text-xs tabular-nums"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {row.samples}×
                </span>
              </div>
            </div>
            <div
              className="h-1 overflow-hidden rounded-full"
              style={{ background: "var(--color-bg-secondary)" }}
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${pct}%`, background: barColor }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ─── AI quality ───────────────────────────────────────────────────

function AiQualitySection({ ai }: { ai: AiQualityMetrics }) {
  return (
    <Section title="AI quality" subtitle="Last 7 days unless noted">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Failure rate"
          value={formatPct(ai.failureRate7d)}
          sublabel={`${ai.failedSessions7d} of ${ai.failedSessions7d + ai.completedSessions7d} sessions`}
          tone={ai.failureRate7d >= 0.05 ? "danger" : ai.failureRate7d >= 0.02 ? "warning" : "ok"}
        />
        <Metric
          label="Avg analyze latency"
          value={
            ai.avgAnalysisSeconds7d == null
              ? "—"
              : formatDurationSeconds(ai.avgAnalysisSeconds7d)
          }
          sublabel="session create → first report row"
        />
        <Metric
          label="Inference acceptance"
          value={
            ai.inferenceAcceptanceRate30d == null
              ? "—"
              : formatPct(ai.inferenceAcceptanceRate30d)
          }
          sublabel={`${ai.inferenceArtifactsTotal30d.toLocaleString("en-IN")} ai-inferred · last 30d`}
          tone={
            ai.inferenceAcceptanceRate30d != null && ai.inferenceAcceptanceRate30d < 0.5
              ? "warning"
              : undefined
          }
        />
        <Metric
          label="Completed sessions"
          value={ai.completedSessions7d.toLocaleString("en-IN")}
          sublabel="state = complete · 7d"
        />
      </div>
    </Section>
  );
}

// ─── AI Read opening variety ───────────────────────────────

function AiReadSection({
  aiRead,
}: {
  aiRead: AiReadMetrics;
}) {
  const retryTone =
    aiRead.retryRate30d >= 0.2
      ? "danger"
      : aiRead.retryRate30d >= 0.1
        ? "warning"
        : "ok";
  const persistTone =
    aiRead.persistenceRate30d >= 0.05
      ? "danger"
      : aiRead.persistenceRate30d > 0
        ? "warning"
        : "ok";
  return (
    <Section
      title="AI Read — opening variety"
      subtitle="Last 30 days · healthy state: <20% retry, <5% persistence"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Formulaic-opening retry rate"
          value={formatPct(aiRead.retryRate30d)}
          sublabel={`${aiRead.formulaicRetries30d} retries of ${aiRead.completeSessions30d} sessions`}
          tone={retryTone}
        />
        <Metric
          label="Persistence rate (after retry)"
          value={formatPct(aiRead.persistenceRate30d)}
          sublabel={`${aiRead.formulaicPersisted30d} of ${aiRead.formulaicRetries30d} retried`}
          tone={persistTone}
        />
        <Metric
          label="Sessions analyzed"
          value={aiRead.completeSessions30d.toLocaleString("en-IN")}
          sublabel="complete sessions · 30d"
        />
      </div>
      {aiRead.topOpeningPatterns.length > 0 && (
        <div className="mt-5">
          <h3
            className="mb-2 text-xs font-medium uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Top formulaic openers · first 3 words · last 30d
          </h3>
          <ul className="flex flex-col gap-1.5 text-sm">
            {aiRead.topOpeningPatterns.map((p) => (
              <li
                key={p.pattern}
                className="grid grid-cols-[1fr_60px] items-center gap-3"
              >
                <span
                  className="font-mono text-xs"
                  style={{ color: "var(--color-text-primary)" }}
                >
                  &ldquo;{p.pattern}&hellip;&rdquo;
                </span>
                <span
                  className="text-right text-xs tabular-nums"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {p.count}×
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {aiRead.topOpeningPatterns.length === 0 && (
        <div className="mt-4">
          <EmptyState text="No formulaic openings detected in the last 30 days." />
        </div>
      )}
    </Section>
  );
}

// ─── Summary differentiation ──────────────────────────────────────

function SummaryDifferentiationSection({
  diff,
}: {
  diff: SummaryDifferentiationMetrics;
}) {
  const retryTone =
    diff.retryRate30d >= 0.15
      ? "danger"
      : diff.retryRate30d >= 0.08
        ? "warning"
        : "ok";
  const warningTone =
    diff.warningRate30d >= 0.30
      ? "danger"
      : diff.warningRate30d >= 0.15
        ? "warning"
        : "ok";
  return (
    <Section
      title="AI Read vs. Executive Summary — differentiation"
      subtitle="Last 30 days · healthy: <15% retry, <30% warning"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Metric
          label="High-overlap retry rate (>35%)"
          value={formatPct(diff.retryRate30d)}
          sublabel={`${diff.highOverlapRetries30d} retries of ${diff.completeSessions30d} sessions`}
          tone={retryTone}
        />
        <Metric
          label="Warning-level overlap rate (>20%)"
          value={formatPct(diff.warningRate30d)}
          sublabel={`${diff.warningLevelOverlaps30d} of ${diff.completeSessions30d} sessions`}
          tone={warningTone}
        />
        <Metric
          label="Sessions analyzed"
          value={diff.completeSessions30d.toLocaleString("en-IN")}
          sublabel="complete sessions · 30d"
        />
      </div>
    </Section>
  );
}

// ─── Round-type detail overlap ─────────────────────────────────────

function RoundDetailOverlapSection({
  roundDetail,
}: {
  roundDetail: RoundDetailOverlapMetrics;
}) {
  const strengthsTone =
    roundDetail.strengthsOverlapRate30d >= 0.2
      ? "danger"
      : roundDetail.strengthsOverlapRate30d >= 0.15
        ? "warning"
        : "ok";
  const improvementsTone =
    roundDetail.improvementsOverlapRate30d >= 0.2
      ? "danger"
      : roundDetail.improvementsOverlapRate30d >= 0.15
        ? "warning"
        : "ok";
  const prescriptiveTone =
    roundDetail.prescriptiveLanguageRate30d >= 0.05
      ? "danger"
      : roundDetail.prescriptiveLanguageRate30d > 0
        ? "warning"
        : "ok";
  return (
    <Section
      title="Round-type detail — scorecard quality"
      subtitle="Last 30 days · healthy: <15% overlap on each, <5% prescriptive-language"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Metric
          label="Overlap with Strengths (>25%)"
          value={formatPct(roundDetail.strengthsOverlapRate30d)}
          sublabel={`${roundDetail.strengthsOverlapCount30d} of ${roundDetail.completeSessions30d} sessions`}
          tone={strengthsTone}
        />
        <Metric
          label="Overlap with Improvements (>25%)"
          value={formatPct(roundDetail.improvementsOverlapRate30d)}
          sublabel={`${roundDetail.improvementsOverlapCount30d} of ${roundDetail.completeSessions30d} sessions`}
          tone={improvementsTone}
        />
        <Metric
          label="Prescriptive language rate"
          value={formatPct(roundDetail.prescriptiveLanguageRate30d)}
          sublabel={`${roundDetail.prescriptiveLanguageCount30d} sessions with 'you should / try to / could improve'`}
          tone={prescriptiveTone}
        />
      </div>
    </Section>
  );
}

// ─── Infrastructure ───────────────────────────────────────────────

function InfrastructureSection({ infra }: { infra: InfraMetrics }) {
  return (
    <Section title="Infrastructure">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Metric
          label="Avg session length"
          value={
            infra.avgSessionSeconds30d == null
              ? "—"
              : formatDurationSeconds(infra.avgSessionSeconds30d)
          }
          sublabel="last 30 days, recorded audio"
        />
        <Metric
          label="Monthly infra cost"
          value={
            infra.monthlyInfraCostInr == null
              ? "—"
              : `₹${infra.monthlyInfraCostInr.toLocaleString("en-IN")}`
          }
          sublabel={
            infra.monthlyInfraCostInr == null
              ? "Set MONTHLY_INFRA_COST_INR to populate"
              : "operator-set"
          }
        />
        <Metric
          label="Sessions today"
          value={String(infra.sessionsByDay.at(-1)?.count ?? 0)}
          sublabel="vs. 7-day daily avg"
        />
      </div>
      <div className="mt-4">
        <h3
          className="text-xs font-medium uppercase tracking-wide"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Sessions per day · 7d
        </h3>
        <SessionsTrendChart series={infra.sessionsByDay} />
      </div>
    </Section>
  );
}

// ─── Geo ──────────────────────────────────────────────────────────

function GeoSection({ geo }: { geo: GeoMetrics }) {
  const hasCountryData = geo.signupsByCountry30d.length > 0;
  const hasSubdivisionData = geo.indianSignupsBySubdivision90d.length > 0;
  return (
    <Section
      title="Geography"
      subtitle={
        geo.totalSignups30d.toLocaleString("en-IN") +
        " signups in the last 30 days"
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3
            className="mb-2 text-xs font-medium uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Signups by country · last 30d
          </h3>
          {hasCountryData ? (
            <CountryBarChart
              data={geo.signupsByCountry30d.map((r) => ({
                label: r.label,
                count: r.count,
              }))}
              ariaLabel="Signups by country, last 30 days"
            />
          ) : (
            <EmptyState text="No signups in the last 30 days." />
          )}
        </div>
        <div>
          <h3
            className="mb-2 text-xs font-medium uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Indian signups by state · last 90d
          </h3>
          {hasSubdivisionData ? (
            <CountryBarChart
              data={geo.indianSignupsBySubdivision90d.map((r) => ({
                label: r.subdivisionCode,
                count: r.count,
              }))}
              ariaLabel="Indian signups by state, last 90 days"
            />
          ) : (
            <EmptyState text="No subdivision data yet. Install GeoLite2-City and re-deploy." />
          )}
        </div>
      </div>

      <div className="mt-6">
        <h3
          className="mb-2 text-xs font-medium uppercase tracking-wide"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Signups by country · all time (top 20)
        </h3>
        {geo.signupsByCountryAllTime.length > 0 ? (
          <CountryBarChart
            data={geo.signupsByCountryAllTime.map((r) => ({
              label: r.label,
              count: r.count,
            }))}
            maxBars={20}
            ariaLabel="Lifetime signups by country"
          />
        ) : (
          <EmptyState text="No signups recorded yet." />
        )}
      </div>
    </Section>
  );
}

// ─── Engagement ───────────────────────────────────────────────────

function EngagementSection({ engagement }: { engagement: EngagementMetrics }) {
  const completenessTotal = engagement.profileCompleteness.reduce(
    (acc, b) => acc + b.users,
    0,
  );
  return (
    <Section title="Feature engagement">
      <div className="grid gap-6 lg:grid-cols-3">
        <Metric
          label="Story rebuilds adoption"
          value={formatPct(engagement.rebuildAdoption.rate)}
          sublabel={`${engagement.rebuildAdoption.rebuildUsersEver.toLocaleString(
            "en-IN",
          )} ever / ${engagement.rebuildAdoption.activeUsers30d.toLocaleString(
            "en-IN",
          )} active 30d`}
        />
        <Metric
          label="Outcomes recorded"
          value={formatPct(engagement.outcomesRecorded.rate)}
          sublabel={`${engagement.outcomesRecorded.sessionsWithOutcome30d.toLocaleString(
            "en-IN",
          )} of ${engagement.outcomesRecorded.completeSessions30d.toLocaleString(
            "en-IN",
          )} complete sessions (30d)`}
        />
        <Metric
          label="Users with full profile"
          value={
            completenessTotal === 0
              ? "—"
              : formatPct(
                  (engagement.profileCompleteness.find((b) => b.completed === 4)?.users ?? 0) /
                    completenessTotal,
                )
          }
          sublabel={`${completenessTotal.toLocaleString("en-IN")} users measured`}
        />
      </div>

      <div className="mt-5">
        <h3
          className="mb-2 text-xs font-medium uppercase tracking-wide"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Profile completeness · all users
        </h3>
        <CompletenessBars
          buckets={engagement.profileCompleteness}
          total={completenessTotal}
        />
      </div>
    </Section>
  );
}

function CompletenessBars({
  buckets,
  total,
}: {
  buckets: Array<{ completed: number; users: number }>;
  total: number;
}) {
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {buckets.map((b) => {
        const pct = total === 0 ? 0 : (b.users / total) * 100;
        return (
          <li
            key={b.completed}
            className="grid grid-cols-[60px_1fr_80px] items-center gap-3"
          >
            <span
              className="text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {b.completed}/4
            </span>
            <div
              className="h-2 overflow-hidden rounded-full"
              style={{ background: "var(--color-bg-secondary)" }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${pct}%`,
                  background: "var(--color-success)",
                }}
              />
            </div>
            <span
              className="text-right text-xs tabular-nums"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {b.users.toLocaleString("en-IN")} · {pct.toFixed(1)}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-md border p-5"
      style={{
        background: "var(--color-bg-primary)",
        borderColor: "var(--color-border-tertiary)",
      }}
    >
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2
          className="text-lg font-semibold"
          style={{ color: "var(--color-text-primary)" }}
        >
          {title}
        </h2>
        {subtitle && (
          <span
            className="text-xs"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {subtitle}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  sublabel,
  tone,
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: "ok" | "warning" | "danger";
}) {
  const valueColor = (() => {
    switch (tone) {
      case "danger":
        return "var(--color-danger-text)";
      case "warning":
        return "var(--color-warning-text)";
      case "ok":
        return "var(--color-success-text)";
      default:
        return "var(--color-text-primary)";
    }
  })();
  return (
    <div>
      <div
        className="text-xs uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-2xl font-semibold tabular-nums"
        style={{ color: valueColor }}
      >
        {value}
      </div>
      {sublabel && (
        <div
          className="mt-0.5 text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {sublabel}
        </div>
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div
      className="rounded-md p-6 text-center text-sm italic"
      style={{
        background: "var(--color-bg-secondary)",
        color: "var(--color-text-tertiary)",
      }}
    >
      {text}
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

function formatPct(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds - minutes * 60);
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
}
