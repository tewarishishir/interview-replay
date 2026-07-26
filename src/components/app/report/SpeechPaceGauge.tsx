"use client";

import { useEffect, useMemo } from "react";
import { generatePaceNarrative } from "@/lib/analytics/narratives";
import { classifySpeechPace } from "@/lib/analytics/per-session";

import { computeSpeechPaceGaugeMetrics } from "./analytics-utils";

/**
 * Words-per-minute gauge rendered at the top of the Communication
 * section. Visualizes the candidate's overall round-level speech
 * pace against the three coaching bands the rest of the Analytics
 * surface uses:
 *
 *   < 120 wpm  — measured       (blue,  `var(--color-info)`)
 *   120..170   — conversational (teal,  `var(--color-success)`)
 *   > 170      — brisk          (amber, `var(--color-warning)`)
 *
 * Calculations are intentionally simple: WPM is `wordCount /
 * (durationSeconds / 60)` rounded to the nearest integer. The
 * needle position is clamped to a [0, 220] visible range so a
 * runaway 300+ WPM transcript doesn't shoot the needle off the
 * arc — but the centre text shows the ACTUAL wpm and the
 * narrative generator handles the >200 case explicitly.
 *
 * Renders nothing (`return null`) when there's no signal: either
 * `durationSeconds` or `wordCount` is 0. The Communication section
 * still renders the rest of its content in that case; the gauge
 * just doesn't appear.
 *
 * Theme-aware: every color is sourced from a CSS variable
 * (`var(--color-*)`) so the gauge renders correctly in both
 * light and dark themes without recompiling. The arc segments
 * intentionally avoid hardcoded hex values — see
 * `tests/theme/resolve.test.ts` for the related design intent on
 * semantic colors.
 */
export interface SpeechPaceGaugeProps {
  /** Total spoken word count for the round. */
  wordCount: number;
  /** Round duration in seconds. */
  durationSeconds: number;
  /**
   * Owning session id. When provided, the gauge fires
   * `speech_pace_gauge_viewed` on mount (once per
   * mount, deduped via the effect dependency on `sessionId`).
   * Pass `null` (e.g. Storybook / unit-harness renders) to
   * suppress the event without disabling the visual.
   */
  sessionId?: string | null;
}

export function SpeechPaceGauge({
  wordCount,
  durationSeconds,
  sessionId = null,
}: SpeechPaceGaugeProps): React.ReactElement | null {
  // Pure math lives in `analytics-utils.ts` so its boundary
  // semantics (clamping, integer rounding, angle interpolation)
  // are pinned by a vitest unit test without dragging a DOM into
  // the test runner. A `null` return is the "no signal — don't
  // render" gate; we keep the hook running unconditionally so
  // React's hook order stays stable across re-renders.
  const metrics = useMemo(
    () => computeSpeechPaceGaugeMetrics(wordCount, durationSeconds),
    [wordCount, durationSeconds],
  );
  const hasSignal = metrics !== null;
  const wpm = metrics?.wpm ?? 0;
  const angle = metrics?.angleDegrees ?? -90;
  const band = useMemo(
    () => (hasSignal ? classifySpeechPace(wpm) : "measured"),
    [hasSignal, wpm],
  );
  const narrative = useMemo(
    () => (hasSignal ? generatePaceNarrative(wpm) : ""),
    [hasSignal, wpm],
  );

  useEffect(() => {
    // Analytics event placeholder (external tracking removed).
  }, [hasSignal, sessionId, wpm, band]);

  if (!hasSignal) return null;

  return (
    <div
      data-testid="speech-pace-gauge"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        width: "100%",
      }}
    >
      {/*
        ViewBox is intentionally taller than the arc geometry needs
        so the centre arc's APEX (not the segment-join point at
        y=56) has clear headroom for the "conversational" label.
        The middle arc travels from (60, 56) to (180, 56) with
        radius 90, which puts the highest point of the centreline
        at y≈33 and the outer-stroke top edge at y≈26. The label
        baseline sits at y=14 (text body y=4..14) so there's a
        ~12px gap to the arc's top edge — symmetric with the gap
        the bottom "measured" / "brisk" labels have to the arc's
        bottom endpoints.

        Earlier revisions placed the arc at y=36 with the label at
        y=14, but that put the arc apex at y≈6 (outer edge) —
        directly inside the label's vertical extent. The label
        looked like it was sitting on the green stroke.
      */}
      <svg
        width="240"
        viewBox="0 0 240 160"
        role="img"
        aria-label={`Speech pace gauge showing ${wpm} words per minute, in the ${band} range`}
        style={{ display: "block" }}
      >
        {/*
          Three arc segments forming the 180-degree gauge. Each
          stroke pulls its color from a semantic CSS variable so
          dark/light theme swaps render correctly without a
          recompile. Rounded line caps keep the visual continuous
          across the band joins.
        */}
        <path
          d="M 30 130 A 90 90 0 0 1 60 56"
          fill="none"
          stroke="var(--color-info)"
          strokeWidth={14}
          strokeLinecap="round"
        />
        <path
          d="M 60 56 A 90 90 0 0 1 180 56"
          fill="none"
          stroke="var(--color-success)"
          strokeWidth={14}
          strokeLinecap="round"
        />
        <path
          d="M 180 56 A 90 90 0 0 1 210 130"
          fill="none"
          stroke="var(--color-warning)"
          strokeWidth={14}
          strokeLinecap="round"
        />

        {/*
          Needle. Rotated as a group about the gauge centre
          (120, 130) — the line + pivot circle live in the same
          group so the pivot stays anchored regardless of angle.
          Angle is derived from the CLAMPED wpm so extreme values
          park the needle at the right edge instead of spinning
          off the arc.
        */}
        <g transform={`rotate(${angle} 120 130)`}>
          <line
            x1={120}
            y1={130}
            x2={120}
            y2={60}
            stroke="var(--color-text-primary)"
            strokeWidth={2}
            strokeLinecap="round"
          />
          <circle cx={120} cy={130} r={5} fill="var(--color-text-primary)" />
        </g>

        {/*
          Position labels around the arc. Sentence case
          intentionally — the legend below uses Title Case for
          the legend swatches, but the arc labels read as
          descriptive endpoints, not as proper-noun band names.
          The y coordinates for "measured" / "brisk" track the
          arc's bottom endpoints (y=130 centreline + 7px stroke
          radius = y≈137 outer edge; labels at y=148 give a ~11px
          gap to the arc's bottom).
        */}
        <text
          x={30}
          y={148}
          textAnchor="middle"
          fontSize={10}
          fill="var(--color-text-secondary)"
        >
          measured
        </text>
        <text
          x={120}
          y={14}
          textAnchor="middle"
          fontSize={10}
          fill="var(--color-text-secondary)"
        >
          conversational
        </text>
        <text
          x={210}
          y={148}
          textAnchor="middle"
          fontSize={10}
          fill="var(--color-text-secondary)"
        >
          brisk
        </text>
      </svg>

      {/*
        Numeric readout. Rendered OUTSIDE the SVG (as HTML) so the
        needle line — which pivots at the dome's bottom centre and
        sweeps across any text placed inside the dome — can never
        visually slash through the number or its label. Previously
        rendered as two centred <text> elements at y=92 and y=108
        inside the SVG; at low-wpm angles (≈-80°) the needle ran
        right through "words per minute", and at angles near 0°
        the needle bisected the big number itself.
      */}
      <div
        style={{
          marginTop: "4px",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "center",
          gap: "6px",
        }}
      >
        <span
          style={{
            fontSize: "28px",
            fontWeight: 500,
            color: "var(--color-text-primary)",
            lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {wpm}
        </span>
        <span
          className="text-muted-foreground"
          style={{ fontSize: "12px" }}
        >
          words per minute
        </span>
      </div>

      <ul
        aria-label="Speech pace legend"
        style={{
          display: "flex",
          justifyContent: "center",
          flexWrap: "wrap",
          gap: "20px",
          marginTop: "8px",
          padding: 0,
          listStyle: "none",
        }}
      >
        <LegendItem color="var(--color-info)" label="Measured (under 120)" />
        <LegendItem
          color="var(--color-success)"
          label="Conversational (120–170)"
        />
        <LegendItem color="var(--color-warning)" label="Brisk (170+)" />
      </ul>

      <p
        className="italic text-muted-foreground"
        style={{
          textAlign: "center",
          fontSize: "12px",
          marginTop: "16px",
          maxWidth: "320px",
        }}
      >
        {narrative}
      </p>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <li
      className="text-muted-foreground"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        fontSize: "11px",
      }}
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
