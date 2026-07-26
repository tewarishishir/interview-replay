"use client";

import { useMemo } from "react";

import {
  aggregateStarCompleteness,
  type StarCompleteness,
  type StarDimensionTotals,
} from "@/lib/analytics/per-session";
import { generateStarNarrative } from "@/lib/analytics/narratives";
import type { PerQuestionAnalytics } from "@/lib/llm";

import {
  formatStarSummary,
  starLabelFor,
  type StarDimensionKey,
} from "./analytics-utils";

interface Props {
  items: ReadonlyArray<PerQuestionAnalytics>;
}

/**
 * Four-bar STAR completeness chart for the Analytics tab.
 *
 * Returns `null` when the rollup has zero scoreable entries — the
 * spec says the entire section hides in that case (the chart with
 * empty bars would carry no signal). The parent decides what to
 * render in the slot.
 *
 * Bar widths come from `aggregateStarCompleteness` so the unit
 * tests pinning that function's math also pin the visible chart.
 */
export function StarCompletenessBars({ items }: Props): React.ReactElement | null {
  const data = useMemo(() => aggregateStarCompleteness(items), [items]);
  const narrative = useMemo(() => generateStarNarrative(data), [data]);

  if (data.totalScoreable === 0) return null;

  const dimensions: StarDimensionKey[] = [
    "situation",
    "task",
    "action",
    "result",
  ];

  return (
    <section aria-labelledby="analytics-star-heading">
      <h3
        id="analytics-star-heading"
        className="text-base font-medium text-foreground"
        style={{ fontSize: "16px" }}
      >
        STAR completeness across all answers
      </h3>
      <p
        className="mt-1 text-muted-foreground"
        style={{ fontSize: "13px" }}
      >
        How consistently each story element appeared in your behavioral
        answers.
      </p>

      <div
        className="mt-4 flex flex-col"
        style={{ gap: "12px" }}
        role="list"
      >
        {dimensions.map((dim) => (
          <StarBar key={dim} dim={dim} totals={data[dim]} />
        ))}
      </div>

      {/*
        Legend. The squares use inline `background` because the
        semantic tokens live as CSS variables (not Tailwind
        utilities) — falling back to Tailwind's bg-* palette would
        drift away from the theme spec under dark mode.
      */}
      <ul
        className="mt-4 flex flex-wrap"
        style={{ gap: "20px" }}
        aria-label="Legend"
      >
        <LegendItem color="var(--color-success)" label="Present" />
        <LegendItem color="var(--color-warning)" label="Weak" />
        <LegendItem color="var(--color-danger)" label="Missing" />
      </ul>

      {narrative !== null && (
        <p
          className="mt-3 italic text-muted-foreground"
          style={{ fontSize: "12px" }}
        >
          {narrative}
        </p>
      )}
    </section>
  );
}

function StarBar({
  dim,
  totals,
}: {
  dim: StarDimensionKey;
  totals: StarDimensionTotals;
}) {
  const label = starLabelFor(dim);
  const summary = formatStarSummary(totals);
  const hasData = totals.total > 0;

  // Bar segments fall back to all-grey when a dimension has zero
  // contributors (every entry was 'na' for it). Rare in practice
  // but keeps the chart from rendering a width-0 invisible bar
  // that would visually collapse the row.
  const presentPct = hasData ? (totals.present / totals.total) * 100 : 0;
  const weakPct = hasData ? (totals.weak / totals.total) * 100 : 0;
  const missingPct = hasData ? (totals.missing / totals.total) * 100 : 0;

  return (
    <div role="listitem" data-dimension={dim}>
      <div
        className="flex items-baseline justify-between"
        style={{ fontSize: "13px" }}
      >
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">{summary}</span>
      </div>
      <div
        className="mt-1.5 flex w-full overflow-hidden"
        style={{
          height: "14px",
          background: "var(--color-bg-secondary)",
          borderRadius: "var(--border-radius-md, 6px)",
        }}
        role="img"
        aria-label={`${label}: ${summary || "no data"}`}
      >
        {presentPct > 0 && (
          <div
            data-segment="present"
            style={{
              width: `${presentPct}%`,
              background: "var(--color-success)",
            }}
          />
        )}
        {weakPct > 0 && (
          <div
            data-segment="weak"
            style={{
              width: `${weakPct}%`,
              background: "var(--color-warning)",
            }}
          />
        )}
        {missingPct > 0 && (
          <div
            data-segment="missing"
            style={{
              width: `${missingPct}%`,
              background: "var(--color-danger)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <li
      className="flex items-center gap-2 text-muted-foreground"
      style={{ fontSize: "11px" }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: "10px",
          height: "10px",
          background: color,
          borderRadius: "2px",
        }}
      />
      {label}
    </li>
  );
}

// Re-export so the tab's "hide entire section" check stays a pure
// import without dragging in the React rendering boundary.
export { aggregateStarCompleteness };
export type { StarCompleteness };
