import type { FunnelMetrics } from "@/lib/admin/queries";

interface FunnelProps {
  data: FunnelMetrics;
}

interface Step {
  label: string;
  count: number;
  /** Percentage of the cohort that reached this step (0..100). */
  pct: number;
  /** Last step in the funnel — the page emphasizes it with a left border. */
  emphasize?: boolean;
}

/**
 * Four-card conversion funnel (Signed up → Onboarded → First analysis
 * → Bought pack). Each card shows its absolute count and the
 * percentage of the cohort that reached the step. The last card
 * (`Bought pack`) gets a 2px left border in the success color
 * per the spec — that's the "money question" of the funnel.
 *
 * When `signed_up = 0` (a brand-new env or a window with no
 * signups), every percentage is 0 and the strings render cleanly
 * — we don't show "NaN%" or "—" because the dashboard's first-day
 * story is "we have no users yet", which IS the truth.
 *
 * Cards are flex children that shrink-wrap on narrow viewports.
 * Arrows are rendered as separate flex items between the cards;
 * they're aria-hidden because the percentage is the same
 * information in text form.
 */
export function Funnel({ data }: FunnelProps) {
  const cohort = data.signed_up;
  const pct = (n: number) => (cohort > 0 ? Math.round((n / cohort) * 100) : 0);

  const steps: Step[] = [
    { label: "Signed up", count: data.signed_up, pct: cohort > 0 ? 100 : 0 },
    { label: "Onboarded", count: data.onboarded, pct: pct(data.onboarded) },
    { label: "First analysis", count: data.first_analysis, pct: pct(data.first_analysis) },
    {
      label: "Bought pack",
      count: data.bought_pack,
      pct: pct(data.bought_pack),
      emphasize: true,
    },
  ];

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {steps.map((step, idx) => (
        <FunnelArrowGroup key={step.label} isFirst={idx === 0}>
          <FunnelStep step={step} />
        </FunnelArrowGroup>
      ))}
    </div>
  );
}

function FunnelArrowGroup({
  children,
  isFirst,
}: {
  children: React.ReactNode;
  isFirst: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {!isFirst && (
        <span
          aria-hidden
          className="text-lg"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          →
        </span>
      )}
      {children}
    </div>
  );
}

function FunnelStep({ step }: { step: Step }) {
  return (
    <div
      className="flex min-w-[140px] flex-col rounded-md p-3"
      style={{
        background: "var(--color-bg-secondary)",
        borderRadius: "var(--border-radius-md, 8px)",
        borderLeft: step.emphasize
          ? `2px solid var(--color-success)`
          : undefined,
      }}
    >
      <div
        className="text-xs"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {step.label}
      </div>
      <div
        className="mt-1 text-2xl font-semibold tabular-nums"
        style={{ color: "var(--color-text-primary)" }}
      >
        {step.count.toLocaleString("en-IN")}
      </div>
      <div
        className="mt-0.5 text-xs"
        style={{ color: "var(--color-text-secondary)" }}
      >
        {step.pct}%
      </div>
    </div>
  );
}
