import Link from "next/link";
import { LocalTime } from "@/components/ui/local-time";
import { ArrowRight, Check } from "lucide-react";

import type { SessionListItem } from "@/lib/queries/sessions";
import { cn } from "@/lib/utils";
import { CompanyLogo } from "@/components/app/company-logo";
import {
  OUTCOME_BADGE,
  ROUND_TYPE_LABEL,
  SEVEN_DAYS_MS,
  STATE_VARIANTS,
  StatusPill,
} from "@/components/app/session-card";

/**
 * Compact "list" layout for a single session — the row counterpart
 * to `SessionCard`. Same data + same selection-mode contract; only
 * the visual layout differs:
 *
 *   - Card: 3-column grid, status pill top-right, generous padding.
 *   - Row:  one line of meta + title on the left, status/outcome/
 *           date stacked on the right, hairline divider between
 *           rows. Designed so 20+ sessions still fit on a single
 *           viewport without scrolling.
 *
 * Selection mode swaps the outer `Link` for a `button` that toggles
 * the parent's selection state — mirroring `SessionCard` so the
 * dashboard's bulk-delete flow works identically across views.
 */

/**
 * Outcome rendering for the row layout. Mirrors `SessionCard`'s
 * rules: badge when recorded, muted prompt when stale (>7d), nothing
 * otherwise. Only surfaces for `complete` sessions.
 */
function renderOutcomeArea(session: SessionListItem): React.ReactNode {
  if (session.state !== "complete") return null;

  if (session.outcomeType) {
    return <StatusPill variant={OUTCOME_BADGE[session.outcomeType]} />;
  }

  const ageMs = Date.now() - session.createdAt.getTime();
  if (ageMs < SEVEN_DAYS_MS) return null;

  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
      Record outcome →
    </span>
  );
}

function SessionRowBody({
  session,
  selectMode,
  selected,
}: {
  session: SessionListItem;
  selectMode: boolean;
  selected: boolean;
}) {
  const variant = STATE_VARIANTS[session.state];
  const outcomeArea = renderOutcomeArea(session);

  return (
    <div className="flex w-full items-center gap-3 px-4 py-3 sm:gap-4">
      {selectMode && (
        <span
          aria-hidden
          className={cn(
            "inline-flex size-4 shrink-0 items-center justify-center rounded-sm border",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background",
          )}
        >
          {selected && <Check className="size-3.5" />}
        </span>
      )}

      <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
        <div className="hidden min-w-0 shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary/80 sm:inline-flex sm:basis-36">
          <CompanyLogo name={session.companyName} />
          <span className="truncate">{session.companyName}</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary/80 sm:hidden">
            <CompanyLogo name={session.companyName} />
            <span className="truncate">{session.companyName}</span>
          </div>
          <h3 className="truncate text-sm font-semibold text-foreground sm:text-[0.95rem]">
            {session.roleTitle}
          </h3>
          <p className="truncate text-xs text-muted-foreground">
            {ROUND_TYPE_LABEL[session.roundType]} · {session.level}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <LocalTime
          date={session.createdAt}
          options={{ year: "numeric", month: "short", day: "numeric" }}
          className="hidden text-xs text-muted-foreground sm:inline"
        />
        <StatusPill variant={variant} />
        {!selectMode && outcomeArea}
        {!selectMode && (
          <ArrowRight
            className="size-4 shrink-0 text-primary"
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}

export interface SessionRowProps {
  session: SessionListItem;
  /** Identical contract to `SessionCard.selection`. */
  selection?: {
    selected: boolean;
    onToggle: () => void;
    disabled?: boolean;
  };
}

export function SessionRow({ session, selection }: SessionRowProps) {
  if (selection) {
    const { selected, onToggle, disabled } = selection;
    return (
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={selected}
        aria-label={`${selected ? "Deselect" : "Select"} session: ${session.companyName} ${session.roleTitle}`}
        className={cn(
          "block w-full text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/40",
          "disabled:cursor-not-allowed",
          selected
            ? "bg-primary/5"
            : "hover:bg-primary/[0.04] hover:shadow-sm",
          disabled && "opacity-60",
        )}
      >
        <SessionRowBody
          session={session}
          selectMode
          selected={selected}
        />
      </button>
    );
  }

  return (
    <Link
      href={`/sessions/${session.id}`}
      aria-label={`Open session: ${session.companyName} ${session.roleTitle}`}
      className={cn(
        "group block transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/40",
        "hover:bg-primary/[0.04]",
      )}
    >
      <SessionRowBody session={session} selectMode={false} selected={false} />
    </Link>
  );
}
