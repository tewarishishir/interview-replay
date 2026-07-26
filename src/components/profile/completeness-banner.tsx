"use client";

import { Check, Circle } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { ProfileCompleteness } from "@/lib/queries/profiles";

interface CompletenessBannerProps {
  completeness: ProfileCompleteness;
}

const SECTIONS: ReadonlyArray<{
  key: keyof Omit<ProfileCompleteness, "fraction">;
  label: string;
}> = [
  { key: "resume", label: "Resume" },
  { key: "projects", label: "Projects" },
  { key: "target", label: "Target" },
];

/**
 * Top-of-page summary banner. Counts the three collapsible
 * sections (Resume / Projects / Target) and shows a 0-100%
 * progress bar plus dot/check indicators. The Story bank moved
 * to its own top-level page; the dashboard's separate
 * "Story bank: N" pill carries that signal.
 *
 * Re-derived from `ProfileCompleteness` (computed server-side on
 * page load AND refreshed in-place when the user saves). Keeping
 * the math on the server means the dashboard version of this
 * banner can render the same thing without duplicating logic.
 */
export function CompletenessBanner({ completeness }: CompletenessBannerProps) {
  const pct = Math.round(completeness.fraction * 100);
  return (
    <Card className="mb-6">
      <CardContent className="flex flex-wrap items-center gap-6 p-5">
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Profile completeness
            </h2>
            <span className="text-sm font-semibold">{pct}%</span>
          </div>
          <Progress value={pct} aria-label={`Profile is ${pct}% complete`} />
        </div>
        <ul className="flex flex-wrap items-center gap-3 text-sm">
          {SECTIONS.map((s) => {
            const done = completeness[s.key];
            return (
              <li
                key={s.key}
                className="flex items-center gap-1.5 text-muted-foreground"
              >
                {done ? (
                  <Check
                    className="size-4 text-emerald-600 dark:text-emerald-400"
                    aria-hidden
                  />
                ) : (
                  <Circle className="size-4 opacity-50" aria-hidden />
                )}
                <span className={done ? "text-foreground" : ""}>{s.label}</span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
