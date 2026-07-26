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

interface SessionsTrendChartProps {
  series: Array<{ date: string; count: number }>;
}

/**
 * 7-day session volume bar chart for the Infrastructure section
 * of `/admin/health`. Bars (not lines) because a single series of
 * non-cumulative counts reads better as discrete blocks than as
 * a connected line.
 */
export function SessionsTrendChart({ series }: SessionsTrendChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartJS<"bar"> | null>(null);

  const labels = useMemo(
    () =>
      series.map((s) => {
        const d = new Date(s.date + "T00:00:00Z");
        return d.toLocaleDateString(undefined, {
          weekday: "short",
          timeZone: "UTC",
        });
      }),
    [series],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    chartRef.current?.destroy();
    chartRef.current = new ChartJS(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Sessions",
            data: series.map((s) => s.count),
            backgroundColor: "#7F77DD",
            borderRadius: 3,
            borderSkipped: false,
            maxBarThickness: 36,
          },
        ],
      },
      options: {
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
              label: (item) =>
                `${Number(item.parsed.y ?? 0).toLocaleString("en-IN")} sessions`,
            },
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
            ticks: { color: "rgba(128,128,128,0.85)", precision: 0 },
          },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [series, labels]);

  return (
    <div style={{ height: 160 }}>
      <canvas ref={canvasRef} role="img" aria-label="Sessions per day (7-day)" />
    </div>
  );
}
