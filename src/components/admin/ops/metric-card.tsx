import type { ReactNode } from "react";

interface MetricCardProps {
  label: string;
  /** Pre-formatted primary value, e.g. "12" or "₹1,234". */
  value: string;
  /** Delta number (today − yesterday). Null = no delta line. */
  delta?: number | null;
  /** Suffix for the delta line, e.g. "from yest.". */
  deltaSuffix?: string;
  /** Optional supporting line below the value. */
  supporting?: ReactNode;
  /** "currency" deltas use the same formatter — pass true to render ₹ on the delta. */
  deltaIsCurrency?: boolean;
}

/**
 * Single metric tile for the Ops dashboard. Uses spec tokens so the
 * tile inherits the rest of the admin shell's calm
 * paper-on-paper aesthetic. Three delta colors:
 *
 *   delta > 0  → success (green)
 *   delta < 0  → danger  (coral)
 *   delta === 0 → muted "same"
 *
 * `delta === null` (or omitted) suppresses the delta line entirely
 * — useful for metrics where "vs yesterday" doesn't make sense
 * (e.g. revenue on day 1 of launch).
 */
export function MetricCard({
  label,
  value,
  delta,
  deltaSuffix = "from yest.",
  supporting,
  deltaIsCurrency = false,
}: MetricCardProps) {
  return (
    <div
      className="rounded-md p-3"
      style={{
        background: "var(--color-bg-secondary)",
        borderRadius: "var(--border-radius-md, 8px)",
      }}
    >
      <div
        className="text-xs"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-2xl font-semibold tabular-nums"
        style={{ color: "var(--color-text-primary)" }}
      >
        {value}
      </div>
      {delta !== undefined && delta !== null && (
        <DeltaLine
          delta={delta}
          suffix={deltaSuffix}
          isCurrency={deltaIsCurrency}
        />
      )}
      {supporting != null && (
        <div
          className="mt-1 text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {supporting}
        </div>
      )}
    </div>
  );
}

function DeltaLine({
  delta,
  suffix,
  isCurrency,
}: {
  delta: number;
  suffix: string;
  isCurrency: boolean;
}) {
  if (delta === 0) {
    return (
      <div
        className="mt-1 text-xs"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        same
      </div>
    );
  }
  const positive = delta > 0;
  const abs = Math.abs(delta);
  const formatted = isCurrency
    ? `₹${abs.toLocaleString("en-IN")}`
    : abs.toLocaleString("en-IN");
  // U+2212 (minus sign) per spec; not a hyphen — looks proportional
  // alongside the "+" glyph and is the typographically correct form.
  const sign = positive ? "+" : "\u2212";
  return (
    <div
      className="mt-1 text-xs"
      style={{
        color: positive
          ? "var(--color-success)"
          : "var(--color-danger)",
      }}
    >
      {sign}
      {formatted} {suffix}
    </div>
  );
}
