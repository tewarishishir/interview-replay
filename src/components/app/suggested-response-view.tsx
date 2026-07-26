"use client";

import { AlertTriangle, BookOpenText, Sparkles } from "lucide-react";

import type { SuggestedResponse } from "@/lib/rebuilds/schemas";

/**
 * Pure renderer for a validated `SuggestedResponse`. Used in:
 *
 *   - `rebuild-flow.tsx` Step 4 — the "AI suggested response"
 *     panel beside the user's draft scaffold.
 *   - `story-bank-page.tsx` — inside the per-card expander, next
 *     to the "View AI critique" expander.
 *   - `stories/[id]/page.tsx` — full detail view below the
 *     critique block.
 *
 * Two display modes:
 *
 *   - `variant="full"` (default) — used on the story detail page
 *     and the rebuild-flow scaffold panel. Shows every STAR
 *     section with its label, plus the sources footnote and
 *     caveats list.
 *   - `variant="compact"` — used inside the bank card expander.
 *     Same content, slightly tighter spacing, omits the section
 *     headers' background tint so the inner panel doesn't
 *     compete with the surrounding card.
 *
 * The component is purely presentational. Action buttons
 * (Generate / Regenerate / dismiss) live in the caller so the
 * same renderer is safe on read-only pages.
 *
 * The persistent "this is a starting point" caveat is rendered
 * here too, intentionally co-located with the suggestion so a
 * future caller can't accidentally surface a draft without it.
 */
export interface SuggestedResponseViewProps {
  suggestion: SuggestedResponse;
  variant?: "full" | "compact";
  /**
   * When the suggestion came from a guardrail-trip fallback we
   * dim the rendering and hide the sources block (which is empty
   * anyway). The renderer doesn't decide policy — the caller
   * passes `passedGuardrails` if it has it.
   */
  passedGuardrails?: boolean;
  /**
   * Optional ISO-8601 generation stamp. When present we render a
   * "Generated <relative>" footnote at the bottom so a stale
   * suggestion (cached across profile updates) is visibly old.
   */
  generatedAt?: string | null;
}

export function SuggestedResponseView({
  suggestion,
  variant = "full",
  passedGuardrails = true,
  generatedAt = null,
}: SuggestedResponseViewProps) {
  const compact = variant === "compact";

  return (
    <div className={compact ? "space-y-4" : "space-y-5"}>
      {/* Persistent caveat — never optional. */}
      <div className="rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-sm text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200">
        <AlertTriangle className="mr-2 inline size-4" aria-hidden />
        This is a starting point — edit and make it yours. Interviewers can
        tell when answers are AI-written verbatim.
      </div>

      {!passedGuardrails && (
        <div className="rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 text-sm text-rose-900 dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-200">
          AI generation didn&apos;t produce a grounded draft this time. The
          sections below are placeholders — try again, or fill them in
          yourself using your profile.
        </div>
      )}

      <div
        className={`rounded-xl border-2 border-primary/30 bg-primary/[0.03] ${
          compact ? "p-4" : "p-5"
        }`}
      >
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Headline
        </h3>
        <p className="mt-2 text-sm font-medium leading-relaxed sm:text-base">
          {suggestion.headline}
        </p>
      </div>

      <SuggestionField label="Situation" value={suggestion.situation} compact={compact} />
      <SuggestionField label="Task" value={suggestion.task} compact={compact} />
      <SuggestionField label="Action" value={suggestion.action} compact={compact} />
      <SuggestionField label="Result" value={suggestion.result} compact={compact} />
      {suggestion.whatIWouldChange ? (
        <SuggestionField
          label="What I'd do differently"
          value={suggestion.whatIWouldChange}
          compact={compact}
        />
      ) : null}

      {suggestion.caveats.length > 0 ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            InterviewReplay couldn&apos;t fill these in from your profile
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground/85">
            {suggestion.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {passedGuardrails && suggestion.sources.length > 0 ? (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <BookOpenText className="size-3.5" aria-hidden />
            Drawn from your profile
          </div>
          <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
            {suggestion.sources.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <Sparkles className="mt-0.5 size-3 shrink-0" aria-hidden />
                <span>
                  <span className="font-mono text-[11px] text-foreground/70">
                    {s.field_path}
                  </span>
                  <span className="ml-2">— &ldquo;{truncate(s.field_value, 200)}&rdquo;</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {generatedAt ? (
        <p className="text-xs text-muted-foreground">
          Generated {formatRelative(generatedAt)}.
        </p>
      ) : null}
    </div>
  );
}

function SuggestionField({
  label,
  value,
  compact,
}: {
  label: string;
  value: string;
  compact: boolean;
}) {
  return (
    <div className={compact ? "space-y-1" : "space-y-1.5"}>
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="whitespace-pre-line text-sm leading-relaxed">{value}</p>
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Render a relative time like "5 minutes ago" / "2 days ago"
 * suitable for "Generated X ago" footnotes. Falls back to the
 * raw string if the input doesn't parse.
 */
function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} month${month === 1 ? "" : "s"} ago`;
  const year = Math.floor(month / 12);
  return `${year} year${year === 1 ? "" : "s"} ago`;
}
