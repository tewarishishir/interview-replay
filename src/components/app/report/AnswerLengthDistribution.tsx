"use client";

import { useMemo } from "react";

import { classifyAnswerLengths } from "@/lib/analytics/per-session";
import { generateLengthNarrative } from "@/lib/analytics/narratives";
import type { PerQuestionAnalytics } from "@/lib/llm";

import {
  computeAnswerLengthBandGeometry,
  lengthBandColor,
} from "./analytics-utils";

interface Props {
  items: ReadonlyArray<PerQuestionAnalytics>;
}

/**
 * Per-question answer-length bar chart with a 90-180s target band
 * overlay.
 *
 * Visual contract (post visual-refinement pass):
 *
 *   - Each bar's HEIGHT is proportional to its duration as a
 *     fraction of `maxDuration` — so a 300s answer in a round
 *     that maxes at 300s renders as a full-height bar.
 *   - The 90-180s target band is a HORIZONTAL stripe spanning
 *     the full chart width, with its bottom edge at the y-
 *     coordinate of the 90s mark and its top edge at the 180s
 *     mark (or clamped to the chart top when maxDuration < 180).
 *     The band gives the candidate an at-a-glance "did my answer
 *     land in the right zone" read without needing per-bar
 *     annotations.
 *   - Bars stay coloured by band (in-range teal, too short amber,
 *     too long coral) so the verdict per question is also
 *     readable independent of the stripe.
 *
 * Renders EVERY question (including closing / clarification) so
 * the chart's question count matches the per-question list below
 * it. Closing / clarification rows are painted in a neutral tone
 * (the `meta` band — see `classifyAnswerLengths`) so the eye
 * doesn't read a quick "Any questions for me?" as a length
 * problem. The legend gains a "Closing / clarification" entry
 * only when the chart actually contains such a bar.
 *
 * Returns `null` only when there are NO questions at all — a
 * meta-only round still renders so the candidate sees what the
 * model observed.
 *
 * The vertical-band geometry math lives in
 * `computeAnswerLengthBandGeometry` so vitest can pin it without
 * mounting a DOM.
 */
export function AnswerLengthDistribution({
  items,
}: Props): React.ReactElement | null {
  const classifications = useMemo(() => classifyAnswerLengths(items), [items]);
  const narrative = useMemo(
    () => generateLengthNarrative(classifications),
    [classifications],
  );

  if (classifications.length === 0) return null;

  // Max-of-bars is also the scale for the 90/180s overlay band.
  // Floor of 1s avoids the divide-by-zero when every duration is
  // 0 (defensively: the analyze pipeline guarantees positive
  // durations but the renderer shouldn't trust that).
  const maxDuration = Math.max(
    1,
    ...classifications.map((c) => c.duration_seconds),
  );

  const band = computeAnswerLengthBandGeometry(maxDuration);

  return (
    <section aria-labelledby="analytics-length-heading">
      <h3
        id="analytics-length-heading"
        className="text-base font-medium text-foreground"
        style={{ fontSize: "16px" }}
      >
        Answer length distribution
      </h3>
      <p
        className="mt-1 text-muted-foreground"
        style={{ fontSize: "13px" }}
      >
        How long each answer ran, against the 90–180 second target range.
      </p>

      <div
        className="relative mt-4 w-full"
        style={{ height: "140px" }}
        role="img"
        aria-label="Bar chart of answer length per question with 90 to 180 second target band overlay"
        data-testid="answer-length-chart"
        data-max-duration={maxDuration}
      >
        {/*
          The "plot area" — the rectangle the bars and the
          target-band stripe share. We pin it `bottom: 20px` to
          carve out room below for the Q-N label rail. Everything
          inside this div uses 0-100% on the same vertical scale,
          so the 90s line on the band lines up with the 90s tick
          on each bar.
        */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            bottom: "20px",
          }}
        >
          {/*
            Horizontal target band — full plot-area width,
            vertical position derived from the 90s / 180s lines on
            the maxDuration scale. Sits BEHIND the bars (lower
            z-index via DOM order) so the bars overlap it
            visually. Dashed top + bottom borders mark the 90s and
            180s lines; the "90s" / "180s" labels hang off the
            left edge of the band.
          */}
          {band.heightPct > 0 && (
            <div
              data-overlay="target-band"
              aria-hidden
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: `${band.bottomPct}%`,
                height: `${band.heightPct}%`,
                background: "rgba(29, 158, 117, 0.08)",
                borderTop: "0.5px dashed rgba(29, 158, 117, 0.5)",
                borderBottom: "0.5px dashed rgba(29, 158, 117, 0.5)",
                pointerEvents: "none",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transform: "translateY(-50%)",
                  fontSize: "10px",
                  color: "rgba(29, 158, 117, 0.9)",
                  whiteSpace: "nowrap",
                  padding: "0 4px",
                }}
              >
                180s
              </span>
              <span
                style={{
                  position: "absolute",
                  bottom: 0,
                  left: 0,
                  transform: "translateY(50%)",
                  fontSize: "10px",
                  color: "rgba(29, 158, 117, 0.9)",
                  whiteSpace: "nowrap",
                  padding: "0 4px",
                }}
              >
                90s
              </span>
            </div>
          )}

          {/* Bars. Each column is flex:1; bar height is a %
              of the plot area's height. */}
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              top: 0,
              display: "flex",
              gap: "4px",
              alignItems: "flex-end",
            }}
          >
            {classifications.map((c, i) => {
              const heightPct = (c.duration_seconds / maxDuration) * 100;
              return (
                <div
                  key={c.artifact_id}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    height: "100%",
                    position: "relative",
                    zIndex: 1,
                  }}
                  data-question-index={i}
                  data-band={c.band}
                >
                  <div
                    style={{
                      width: "70%",
                      height: `${heightPct}%`,
                      background: lengthBandColor(c.band),
                      borderRadius: "4px 4px 0 0",
                    }}
                    title={`Q${i + 1}: ${c.duration_seconds}s (${labelForBand(c.band)})`}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Column labels rail. Pinned to the chart's bottom 20px,
            sharing the same flex layout as the bars above so each
            label sits under its column. */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: "20px",
            display: "flex",
            gap: "4px",
          }}
          aria-hidden
        >
          {classifications.map((c, i) => (
            <div
              key={`${c.artifact_id}-label`}
              style={{
                flex: 1,
                textAlign: "center",
                fontSize: "10px",
                color: "var(--color-text-tertiary)",
                lineHeight: "20px",
              }}
            >
              Q{i + 1}
            </div>
          ))}
        </div>
      </div>

      <ul
        className="mt-3 flex flex-wrap"
        style={{ gap: "20px" }}
        aria-label="Legend"
      >
        <LegendItem color="var(--color-success)" label="In range" />
        <LegendItem color="var(--color-warning)" label="Too short" />
        <LegendItem color="var(--color-danger)" label="Too long" />
        {/*
          Only surface the "Closing / clarification" entry when at
          least one such bar is on the chart — adding it
          unconditionally would clutter the legend for the common
          case where every question is gradable.
        */}
        {classifications.some((c) => c.band === "meta") && (
          <LegendItem
            color="var(--color-text-tertiary)"
            label="Closing / clarification"
          />
        )}
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

function labelForBand(
  band: "in_range" | "short" | "long" | "meta",
): string {
  switch (band) {
    case "in_range":
      return "in range";
    case "short":
      return "too short";
    case "long":
      return "too long";
    case "meta":
      return "closing / clarification";
  }
}
