"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  LinearScale,
  Tooltip,
} from "chart.js";

ChartJS.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

export interface CountryBarChartDatum {
  /** Display label (country code, country name, or subdivision). */
  label: string;
  count: number;
}

interface CountryBarChartProps {
  data: CountryBarChartDatum[];
  /** Optional aria label override; defaults to "Users by country". */
  ariaLabel?: string;
  /** Cap how many bars render — handy when the API returns 50 and
   *  we only have room for the top 12. */
  maxBars?: number;
}

/**
 * Horizontal bar chart of `{ label, count }` rows.
 *
 * Used in two places on `/admin/health`:
 *   - "Signups by country · last 30 days"
 *   - "Indian signups by state · last 90 days" (only renders when
 *     the GeoLite2-City DB is installed and there's at least one
 *     row with a subdivision)
 *
 * Sorted by count DESC at the data layer; we render in the order
 * given (no client-side sort) so the caller can swap in a
 * fixed-order series if it ever wants to.
 *
 * Empty-state: caller is responsible for not rendering the chart
 * at all when `data.length === 0`. We deliberately don't render
 * a "no data" placeholder inside the canvas because the bar
 * chart's empty state looks like a bug.
 */
export function CountryBarChart({
  data,
  ariaLabel = "Users by country",
  maxBars = 12,
}: CountryBarChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartJS<"bar"> | null>(null);

  const capped = useMemo(() => data.slice(0, maxBars), [data, maxBars]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    chartRef.current?.destroy();

    chartRef.current = new ChartJS(ctx, {
      type: "bar",
      data: {
        labels: capped.map((d) => d.label),
        datasets: [
          {
            label: "Users",
            data: capped.map((d) => d.count),
            // Single muted accent — matches the Ops dashboard's
            // "Signups" line color so the visual rhyme reads
            // across both surfaces.
            backgroundColor: "#378ADD",
            borderRadius: 3,
            borderSkipped: false,
            maxBarThickness: 22,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(26,26,26,0.9)",
            titleColor: "#f7f6f2",
            bodyColor: "#f7f6f2",
            displayColors: false,
            callbacks: {
              label: (item) => {
                const v = Number(item.parsed.x ?? 0);
                return `${v.toLocaleString("en-IN")} users`;
              },
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: "rgba(128,128,128,0.15)" },
            ticks: {
              color: "rgba(128,128,128,0.85)",
              precision: 0,
            },
          },
          y: {
            grid: { display: false },
            ticks: { color: "rgba(128,128,128,0.85)" },
          },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [capped]);

  // Height grows with the number of bars so the chart isn't
  // squashed at high counts.
  const height = Math.max(160, capped.length * 28 + 32);

  return (
    <div style={{ height }}>
      <canvas ref={canvasRef} role="img" aria-label={ariaLabel} />
    </div>
  );
}
