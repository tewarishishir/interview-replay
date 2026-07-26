"use client";

import { useEffect, useState } from "react";
import { Check, Circle, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Pseudo-progress stepper shown inside the "We're analyzing" panel.
 *
 * Why "pseudo": the real analysis backend (`analyze-session.ts`) runs
 * three concurrent LLM calls (`generate-core-report`,
 * `generate-analytics-report`, `generate-story-highlights`) that all
 * resolve roughly in parallel — there's no single linear progress
 * signal to expose. Driving a stepper purely on wall-clock elapsed
 * time turns out to be the right call here:
 *
 *   - The four phases below map closely to actual measured timings
 *     of the worker (see `## Timing` in `analyze-session.ts`).
 *   - The "labor illusion" (Nielsen Norman, 2017) makes a 90-second
 *     wait feel substantially shorter when broken into visible
 *     sub-steps with concrete labels, even if the labels are
 *     time-driven rather than event-driven.
 *   - When the worker finishes early the parent panel unmounts and
 *     the stepper disappears with it (the surrounding `AnalyzingPoller`
 *     polls every 4 s). If the worker takes longer than the budgeted
 *     ~120 s the stepper just parks on the last step — much friendlier
 *     than a generic spinner sitting on "still working...".
 *
 * If we ever want REAL phase signal we'd persist a `currentPhase`
 * column on `sessions` and tick it from each pipeline step — but
 * that's a meaningful change for a small UX win. This is the cheap
 * version.
 */

type Phase = {
  label: string;
  helper?: string;
  /** Seconds elapsed since mount at which this phase BECOMES active. */
  startAtSeconds: number;
};

const PHASES: Phase[] = [
  {
    label: "Reviewing your transcript",
    startAtSeconds: 0,
  },
  {
    label: "Identifying key questions",
    startAtSeconds: 8,
  },
  {
    label: "Generating personalized feedback",
    helper: "This is the longest step — usually 45-75 seconds.",
    startAtSeconds: 25,
  },
  {
    label: "Finalizing your report",
    startAtSeconds: 95,
  },
];

export function AnalysisStepper() {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // The active phase is the last one whose `startAtSeconds` has elapsed.
  // We never advance past the final phase — the parent panel unmounts
  // when the worker finishes, so "stuck on last step" only happens
  // when analysis is genuinely taking longer than expected, and even
  // then "Finalizing your report" is a friendlier holding state than
  // a bare spinner.
  let activeIndex = 0;
  for (let i = 0; i < PHASES.length; i++) {
    const phase = PHASES[i];
    if (phase && elapsedSeconds >= phase.startAtSeconds) {
      activeIndex = i;
    }
  }

  return (
    <ol className="mx-auto mt-6 max-w-sm space-y-3 text-left">
      {PHASES.map((phase, index) => {
        const isDone = index < activeIndex;
        const isActive = index === activeIndex;
        return (
          <li
            key={phase.label}
            className={cn(
              "flex items-start gap-3 text-sm",
              isDone && "text-muted-foreground",
              isActive && "font-medium text-foreground",
              !isDone && !isActive && "text-muted-foreground/60",
            )}
          >
            <span
              className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center"
              aria-hidden
            >
              {isDone ? (
                <Check className="size-4 text-emerald-600" />
              ) : isActive ? (
                <Loader2 className="size-4 animate-spin text-foreground" />
              ) : (
                <Circle className="size-3 text-muted-foreground/50" />
              )}
            </span>
            <span className="flex flex-col">
              <span>{phase.label}</span>
              {isActive && phase.helper ? (
                <span className="mt-0.5 text-xs font-normal text-muted-foreground">
                  {phase.helper}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
