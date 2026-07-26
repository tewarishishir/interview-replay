"use client";

/**
 * Chart color extraction for libraries that can't read CSS
 * variables directly (Chart.js, Recharts when configured with
 * concrete color props, d3 scales, etc.).
 *
 * Strategy:
 *   - `getChartColors()` reads the current values of the
 *     `--color-chart-1..5` and the semantic status tokens from
 *     the computed style of `<html>`. Returns plain strings the
 *     chart library can use.
 *   - `subscribeToThemeChanges(callback)` watches the `data-theme`
 *     attribute on `<html>` and fires the callback whenever it
 *     flips. Charts can listen and re-render with fresh colors
 *     when the user changes themes.
 *
 * Both helpers no-op during SSR (the document doesn't exist).
 * Charts should defer their first paint to `useEffect` so the
 * first reads happen on the client.
 */

export interface ChartColors {
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  /** Status colors for legend-style annotations on charts. */
  success: string;
  warning: string;
  danger: string;
  info: string;
  /** Text colors for axis labels, tooltips, etc. */
  textPrimary: string;
  textSecondary: string;
  /** Subtle grid lines. */
  borderTertiary: string;
}

/**
 * Read a single CSS variable from `<html>`'s computed style.
 * Returns the trimmed value (`getPropertyValue` includes a leading
 * space when the source has spacing).
 */
function readVar(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

export function getChartColors(): ChartColors {
  return {
    chart1: readVar("--color-chart-1"),
    chart2: readVar("--color-chart-2"),
    chart3: readVar("--color-chart-3"),
    chart4: readVar("--color-chart-4"),
    chart5: readVar("--color-chart-5"),
    success: readVar("--color-success"),
    warning: readVar("--color-warning"),
    danger: readVar("--color-danger"),
    info: readVar("--color-info"),
    textPrimary: readVar("--color-text-primary"),
    textSecondary: readVar("--color-text-secondary"),
    borderTertiary: readVar("--color-border-tertiary"),
  };
}

/**
 * Watch `<html data-theme>` for changes and notify the caller.
 *
 * Returns an unsubscribe function. Use this in a `useEffect`:
 *
 *   useEffect(() => {
 *     const unsubscribe = subscribeToThemeChanges(() => {
 *       chart.options.color = getChartColors().textPrimary;
 *       chart.update();
 *     });
 *     return unsubscribe;
 *   }, []);
 *
 * Implementation note: we observe the SPECIFIC attribute we care
 * about (`data-theme`) rather than `attributes` globally, which
 * keeps the MutationObserver's work minimal.
 */
export function subscribeToThemeChanges(callback: () => void): () => void {
  if (typeof document === "undefined") return () => {};

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "data-theme") {
        callback();
        return;
      }
    }
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  return () => observer.disconnect();
}
