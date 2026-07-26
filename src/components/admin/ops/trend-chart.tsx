"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";

import type { WeeklyTrendEntry } from "@/lib/admin/queries";

// Chart.js is a tree-shaking-aware library — we register only the
// pieces this chart uses. Doing the registration in module scope is
// safe: it's idempotent (the registry deduplicates) and runs once
// per page chunk regardless of how many <TrendChart /> instances
// mount.
ChartJS.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
);

interface TrendChartProps {
  data: WeeklyTrendEntry[];
}

/**
 * 7-day trend chart for the Ops dashboard.
 *
 * Three lines on a shared axis: Signups (blue), New paying (teal),
 * Sessions (purple). Colors come from the spec verbatim — they're
 * NOT the chart palette tokens (`--color-chart-1..5`) because the
 * spec calls out specific hexes that match the legend pills above
 * the chart.
 *
 * Client component because chart.js needs a real <canvas> and DOM
 * to draw into. Imperatively constructed (not the react-chartjs-2
 * wrapper) for two reasons:
 *   1. Smaller bundle — react-chartjs-2 ships a thin wrapper but
 *      pulls extra context plumbing we don't need.
 *   2. Lets us call `chart.destroy()` cleanly on prop changes and
 *      unmount so the chart-side animation timer doesn't leak when
 *      the admin clicks the refresh button.
 */
export function TrendChart({ data }: TrendChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartJS<"line"> | null>(null);

  // Compact axis label: "Sun", "Mon", … so the 7-day chart isn't
  // dominated by ISO date strings. Memoized so a re-render with the
  // same data doesn't re-format.
  const labels = useMemo(
    () =>
      data.map((entry) => {
        // Parse as UTC midnight so the weekday label matches the
        // bucket the query computed in UTC.
        const d = new Date(entry.date + "T00:00:00Z");
        return d.toLocaleDateString(undefined, {
          weekday: "short",
          timeZone: "UTC",
        });
      }),
    [data],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    chartRef.current?.destroy();

    chartRef.current = new ChartJS(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Signups",
            data: data.map((d) => d.signups),
            borderColor: "#378ADD",
            backgroundColor: "#378ADD",
            pointRadius: 3,
            tension: 0.3,
            borderWidth: 2,
          },
          {
            label: "New paying",
            data: data.map((d) => d.paying_users),
            borderColor: "#1D9E75",
            backgroundColor: "#1D9E75",
            pointRadius: 3,
            tension: 0.3,
            borderWidth: 2,
          },
          {
            label: "Sessions",
            data: data.map((d) => d.sessions),
            borderColor: "#7F77DD",
            backgroundColor: "#7F77DD",
            pointRadius: 3,
            tension: 0.3,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // The legend is rendered above the chart in the page so the
        // pills are clickable / stable. Hide the canvas-internal one.
        plugins: {
          legend: { display: false },
          tooltip: {
            // White-on-near-black panel with a slight backdrop so it
            // reads against either light or dark theme. Chart.js
            // doesn't read our CSS variables, so we pin the colors
            // (they look the same in both modes).
            backgroundColor: "rgba(26,26,26,0.9)",
            titleColor: "#f7f6f2",
            bodyColor: "#f7f6f2",
            displayColors: true,
            mode: "index",
            intersect: false,
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: "rgba(128,128,128,0.85)" },
          },
          y: {
            beginAtZero: true,
            grid: { color: "rgba(128,128,128,0.15)" },
            ticks: {
              color: "rgba(128,128,128,0.85)",
              // Integer counts only.
              precision: 0,
            },
          },
        },
        interaction: { mode: "nearest", axis: "x", intersect: false },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [data, labels]);

  return (
    <div style={{ height: 180 }}>
      <canvas ref={canvasRef} role="img" aria-label="7-day metrics trend" />
    </div>
  );
}
