"use client";

import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface SectionShellProps {
  title: string;
  description: string;
  /** ISO timestamp; null = "never updated yet". */
  lastUpdated: string | null;
  excluded: boolean;
  onToggleExcluded: (next: boolean) => void;
  /** Optional badge rendered next to the title (e.g. "3 of 5"). */
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Outer collapsible shell shared by all four profile sections.
 *
 * Responsibilities:
 *   - Title + description + optional count badge.
 *   - "Last updated" surface ("Updated 2 days ago", "Never").
 *   - "Exclude from analysis" switch — flipping it fires
 *     `onToggleExcluded` and the parent persists via the
 *     `/api/profile/exclude` route.
 *   - Collapsible body (defaults open on first paint so the
 *     candidate sees their own data without an extra click).
 *
 * Visual state when excluded: the body is dimmed + "Hidden from
 * analysis" badge to make the consequence obvious.
 */
export function SectionShell(props: SectionShellProps) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-wrap items-start gap-3 border-b border-border p-5">
          <div className="flex flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <CollapsibleTrigger
                className="group flex items-center gap-2 text-left"
                aria-label={`${open ? "Collapse" : "Expand"} ${props.title}`}
              >
                <ChevronDown
                  className={cn(
                    "size-4 text-muted-foreground transition-transform",
                    open ? "" : "-rotate-90",
                  )}
                  aria-hidden
                />
                <h2 className="text-lg font-semibold tracking-tight">
                  {props.title}
                </h2>
              </CollapsibleTrigger>
              {props.badge}
              {props.excluded ? (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                  Hidden from analysis
                </span>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">{props.description}</p>
            <p className="text-xs text-muted-foreground">
              {props.lastUpdated ? (
                <>
                  Updated{" "}
                  <time dateTime={props.lastUpdated}>
                    {formatRelative(props.lastUpdated)}
                  </time>
                </>
              ) : (
                "Not saved yet"
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-sm">
            <Switch
              checked={props.excluded}
              onCheckedChange={props.onToggleExcluded}
              aria-label={`Exclude ${props.title} from analysis`}
            />
            <span className="text-muted-foreground">Exclude from analysis</span>
          </div>
        </div>
        <CollapsibleContent>
          <CardContent
            className={cn(
              "p-5",
              props.excluded ? "opacity-60" : "",
            )}
          >
            {props.children}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

const RELATIVE_FORMATS: ReadonlyArray<{
  unit: Intl.RelativeTimeFormatUnit;
  divisor: number;
}> = [
  { unit: "second", divisor: 1 },
  { unit: "minute", divisor: 60 },
  { unit: "hour", divisor: 60 * 60 },
  { unit: "day", divisor: 60 * 60 * 24 },
  { unit: "month", divisor: 60 * 60 * 24 * 30 },
  { unit: "year", divisor: 60 * 60 * 24 * 365 },
];

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  const abs = Math.abs(seconds);
  // Pick the largest unit for which the value is >= 1.
  let pickIdx = 0;
  for (let i = RELATIVE_FORMATS.length - 1; i >= 0; i--) {
    if (abs >= RELATIVE_FORMATS[i]!.divisor) {
      pickIdx = i;
      break;
    }
  }
  const { unit, divisor } = RELATIVE_FORMATS[pickIdx]!;
  const value = Math.round(seconds / divisor);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  return fmt.format(-value, unit);
}
