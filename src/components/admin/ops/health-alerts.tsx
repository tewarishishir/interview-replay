import type { HealthAlert } from "@/lib/admin/queries";

interface HealthAlertsProps {
  alerts: HealthAlert[];
}

/**
 * Health-alerts panel for the Ops dashboard. Alerts are pre-sorted
 * critical → warning → info by `getHealthAlerts`. Each alert is a
 * card with a 3px left border in the matching semantic color and a
 * background tint pulled from the matching `--color-{sev}-bg` token.
 *
 * Empty state: a single muted "All systems normal" line. We
 * intentionally do NOT render a "0 alerts" badge or animate the
 * panel away — the founder needs to see at a glance that the
 * panel updated. If the empty-state ever became confusing we can
 * stamp the last-checked timestamp here.
 */
export function HealthAlerts({ alerts }: HealthAlertsProps) {
  if (alerts.length === 0) {
    return (
      <p
        className="text-sm italic"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        All systems normal.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {alerts.map((alert, i) => (
        <li key={`${alert.title}-${i}`}>
          <AlertCard alert={alert} />
        </li>
      ))}
    </ul>
  );
}

const SEVERITY_STYLES: Record<
  HealthAlert["severity"],
  { borderColor: string; background: string; textColor: string }
> = {
  critical: {
    borderColor: "var(--color-danger)",
    background: "var(--color-danger-bg)",
    textColor: "var(--color-danger-text)",
  },
  warning: {
    borderColor: "var(--color-warning)",
    background: "var(--color-warning-bg)",
    textColor: "var(--color-warning-text)",
  },
  info: {
    borderColor: "var(--color-info)",
    background: "var(--color-info-bg)",
    textColor: "var(--color-info-text)",
  },
};

function AlertCard({ alert }: { alert: HealthAlert }) {
  const style = SEVERITY_STYLES[alert.severity];
  return (
    <div
      className="rounded-md p-3"
      style={{
        background: style.background,
        borderLeft: `3px solid ${style.borderColor}`,
        borderRadius: "var(--border-radius-md, 8px)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className="text-[13px] font-medium leading-snug"
          style={{ color: style.textColor }}
        >
          {alert.title}
        </div>
        <div
          className="shrink-0 text-[11px] uppercase tracking-wide"
          style={{ color: style.textColor, opacity: 0.7 }}
        >
          {alert.scope}
        </div>
      </div>
      <p
        className="mt-1 text-xs leading-snug"
        style={{ color: "var(--color-text-secondary)" }}
      >
        {alert.description}
      </p>
    </div>
  );
}
