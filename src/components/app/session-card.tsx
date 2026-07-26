import Link from "next/link";
import { LocalTime } from "@/components/ui/local-time";
import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Circle,
  Clock,
  FileText,
  Loader2,
  Mic,
  MoreHorizontal,
  PartyPopper,
  Undo2,
  UploadCloud,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import type { SessionListItem } from "@/lib/queries/sessions";
import { Card } from "@/components/ui/card";
import { CompanyLogo } from "@/components/app/company-logo";
import { cn } from "@/lib/utils";

export const ROUND_TYPE_LABEL: Record<SessionListItem["roundType"], string> = {
  coding: "Coding",
  system_design: "System design",
  behavioral: "Behavioral",
  other: "Other",
};

/**
 * Visual recipe for a status pill: label text, the icon that prefixes
 * it, and a Tailwind className string with both light- and dark-mode
 * variants. The light-mode pairs use `-100` / `-800` (not `/10`
 * opacity overlays) so the colors don't wash out on a white page —
 * matching the report-view tab style the design spec calls for.
 *
 * `spin` is opt-in for in-flight states (`analyzing`) so the
 * `Loader2` icon actually spins instead of looking frozen.
 */
export interface StatusVariant {
  label: string;
  icon: LucideIcon;
  className: string;
  spin?: boolean;
}

/**
 * Color recipes are tuned per theme:
 *
 *  - Light mode uses SOLID colored backgrounds with white text. On a
 *    white page the previous `-100` / `/10` overlays read as washed
 *    out — the eye has no edge to lock onto. A solid `bg-emerald-500`
 *    behaves the way "status" pills do in Linear/GitHub: present,
 *    clearly an indicator, easy to scan across a grid.
 *
 *  - Dark mode keeps the soft "tinted glow" (15% bg on a colored
 *    base, 300-shade text, 30% border). Solid white-on-color reads
 *    as harsh on a near-black canvas.
 *
 * Neutral states (`created`, `expired`, `withdrew`, `other`) stay
 * deliberately quiet — they're not actionable, so they shouldn't
 * fight for attention with `complete`/`offer`/`failed`.
 */
export const STATE_VARIANTS: Record<
  SessionListItem["state"],
  StatusVariant
> = {
  created: {
    label: "Not started",
    icon: Circle,
    className:
      "bg-slate-200 text-slate-800 border-slate-300 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-700",
  },
  recording: {
    label: "Recording",
    icon: Mic,
    className:
      "bg-primary text-primary-foreground border-primary dark:bg-primary/15 dark:text-primary dark:border-primary/40",
  },
  uploading: {
    label: "Uploading",
    icon: UploadCloud,
    className:
      "bg-primary text-primary-foreground border-primary dark:bg-primary/15 dark:text-primary dark:border-primary/40",
  },
  transcribing: {
    label: "Transcribing",
    icon: FileText,
    className:
      "bg-primary text-primary-foreground border-primary dark:bg-primary/15 dark:text-primary dark:border-primary/40",
  },
  review: {
    label: "Awaiting review",
    icon: Clock,
    className:
      "bg-amber-500 text-white border-amber-600 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30",
  },
  analyzing: {
    label: "Analyzing",
    icon: Loader2,
    className:
      "bg-primary text-primary-foreground border-primary dark:bg-primary/15 dark:text-primary dark:border-primary/40",
    spin: true,
  },
  complete: {
    label: "Complete",
    icon: CheckCircle2,
    className:
      "bg-emerald-500 text-white border-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30",
  },
  // `deleted` rows are filtered out by the dashboard query — listed
  // here only to keep the type exhaustiveness check honest.
  deleted: {
    label: "Deleted",
    icon: XCircle,
    className: "bg-muted text-muted-foreground border-border",
  },
  failed: {
    label: "Failed",
    icon: AlertCircle,
    className:
      "bg-rose-500 text-white border-rose-600 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30",
  },
  expired: {
    label: "Expired",
    icon: Clock,
    className:
      "bg-slate-200 text-slate-800 border-slate-300 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-700",
  },
};

export interface OutcomeVariant {
  label: string;
  icon: LucideIcon;
  className: string;
}

/**
 * Outcome pills follow the same theme split as `STATE_VARIANTS`:
 * solid filled in light mode (so they read as a positive/negative
 * verdict), soft glow in dark mode. Neutral verdicts (`withdrew`,
 * `other`) stay quiet so the eye lands on the genuine signals
 * (`Offer` / `Advanced` / `Rejected`).
 */
export const OUTCOME_BADGE: Record<
  NonNullable<SessionListItem["outcomeType"]>,
  OutcomeVariant
> = {
  received_offer: {
    // The "Offer" pill earns a celebratory treatment distinct from
    // every other state — it's the headline outcome the whole app is
    // working toward. Amber/gold reads as "trophy" without competing
    // with the emerald `Complete` STATE pill (so the eye doesn't
    // conflate "the analysis finished" with "I actually got the
    // job") or the sky `Advanced` outcome, and the PartyPopper
    // sells the emotional weight of the moment without adding a
    // custom illustration.
    label: "Offer",
    icon: PartyPopper,
    className:
      "bg-amber-500 text-white border-amber-600 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30",
  },
  advanced_to_next_round: {
    label: "Advanced",
    icon: ArrowUpRight,
    className:
      "bg-sky-500 text-white border-sky-600 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30",
  },
  did_not_advance: {
    label: "Did not advance",
    icon: XCircle,
    className:
      "bg-[#9B7B6E] text-white border-[#7a5c51] dark:bg-[#B79588]/15 dark:text-[#c9a99b] dark:border-[#B79588]/30",
  },
  withdrew: {
    label: "Withdrew",
    icon: Undo2,
    className:
      "bg-slate-200 text-slate-800 border-slate-300 dark:bg-slate-700/60 dark:text-slate-300 dark:border-slate-600",
  },
  no_response: {
    label: "No response",
    icon: Clock,
    className:
      "bg-amber-500 text-white border-amber-600 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30",
  },
  other: {
    label: "Other",
    icon: MoreHorizontal,
    className:
      "bg-slate-200 text-slate-800 border-slate-300 dark:bg-slate-700/60 dark:text-slate-300 dark:border-slate-600",
  },
};

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Shared pill renderer for both status and outcome chips. Centralizing
 * the layout means the icon-to-text gap, padding, and rounding stay
 * locked across every consumer — and the icon picks up the parent's
 * text color via `currentColor` for free.
 */
export function StatusPill({
  variant,
  className,
}: {
  variant: StatusVariant | OutcomeVariant;
  className?: string;
}) {
  const Icon = variant.icon;
  const spin = "spin" in variant && variant.spin === true;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        variant.className,
        className,
      )}
    >
      <Icon
        className={cn("size-3.5", spin && "animate-spin")}
        aria-hidden
      />
      {variant.label}
    </span>
  );
}

/**
 * Outcome rendering rules for the dashboard card:
 *   - Outcome recorded: render the colored badge.
 *   - No outcome AND session ≥ 7 days old: render the muted prompt.
 *   - No outcome AND session < 7 days old: render nothing (the
 *     candidate hasn't had time to hear back yet — pressuring
 *     them on day 2 is a UX antipattern the spec calls out).
 *
 * Only applied when the session is `complete` — earlier states
 * have their own status badge in the top-right and an outcome
 * surface there would be premature.
 */
export function renderOutcomeArea(
  session: SessionListItem,
): React.ReactNode {
  if (session.state !== "complete") return null;

  if (session.outcomeType) {
    const badge = OUTCOME_BADGE[session.outcomeType];
    // Guard against stale DB rows whose outcome_type pre-dates a rename
    // (e.g. 'rejected' → 'did_not_advance'). If the badge is missing,
    // fall through to the "record outcome" prompt rather than crashing.
    if (badge) {
      return <StatusPill variant={badge} />;
    }
  }

  const ageMs = Date.now() - session.createdAt.getTime();
  if (ageMs < SEVEN_DAYS_MS) return null;

  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
      Record outcome →
    </span>
  );
}

/**
 * Body shared between the link and selection modes. Pulled into a
 * helper so both wrappers render the exact same visual layout —
 * the only difference is the outermost interactive element and a
 * checkbox affordance in selection mode.
 */
function SessionCardBody({
  session,
  selectMode,
  selected,
}: {
  session: SessionListItem;
  selectMode: boolean;
  selected: boolean;
}) {
  const variant = STATE_VARIANTS[session.state] ?? STATE_VARIANTS["created"];
  const outcomeArea = renderOutcomeArea(session);

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {selectMode && (
            // Presentational checkbox — the parent button owns the
            // click + a11y semantics (aria-pressed). We deliberately
            // avoid the Radix Checkbox here because its root renders
            // as a <button>, and a <button> nested in a <button>
            // breaks HTML and triggers a hydration error.
            <span
              aria-hidden
              className={cn(
                "mt-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm border",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background",
              )}
            >
              {selected && <Check className="size-3.5" />}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary/80">
              <CompanyLogo name={session.companyName} />
              <span className="truncate">{session.companyName}</span>
            </div>
            <h3 className="mt-1.5 truncate text-base font-semibold text-foreground">
              {session.roleTitle}
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {ROUND_TYPE_LABEL[session.roundType]} · {session.level}
            </p>
          </div>
        </div>
        <StatusPill variant={variant} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <LocalTime
          date={session.createdAt}
          options={{ year: "numeric", month: "short", day: "numeric" }}
        />
        <div className="flex items-center gap-2">
          {!selectMode && outcomeArea}
          {!selectMode && (
            <span className="inline-flex items-center gap-1 font-medium text-primary">
              View
              <ArrowRight className="size-3.5" aria-hidden />
            </span>
          )}
        </div>
      </div>
    </>
  );
}

export interface SessionCardProps {
  session: SessionListItem;
  /**
   * When provided, the card renders in "selection mode": clicking it
   * toggles `selected` instead of navigating to the session detail
   * page. A checkbox affordance is rendered next to the title and
   * the trailing "View →" link is hidden so the card reads
   * unambiguously as a selectable row.
   *
   * Omit this prop entirely (the default) to get the original
   * link-style card used everywhere else.
   */
  selection?: {
    selected: boolean;
    onToggle: () => void;
    /**
     * Lock toggling — used by the bulk-delete flow to prevent the
     * selection from drifting while the delete loop is in flight.
     * The button still renders (so the user can see what's pending)
     * but pointer events and the spacebar are dropped.
     */
    disabled?: boolean;
  };
}

/**
 * Hover treatment shared by both link and selection variants:
 * a soft lift (translate + shadow) plus a faint primary-tinted
 * border so the card visibly "reacts" to the pointer instead of
 * sitting flat. `motion-reduce` strips the translate so users on
 * reduced-motion don't get any vertical jitter.
 */
const CARD_HOVER =
  "transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md motion-reduce:hover:translate-y-0";

export function SessionCard({ session, selection }: SessionCardProps) {
  if (selection) {
    const { selected, onToggle, disabled } = selection;
    return (
      <Card
        className={cn(
          CARD_HOVER,
          selected
            ? "border-primary/60 bg-primary/5 shadow-md"
            : "hover:bg-muted/30",
          disabled && "opacity-60 hover:translate-y-0 hover:shadow-sm",
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          aria-pressed={selected}
          aria-label={`${selected ? "Deselect" : "Select"} session: ${session.companyName} ${session.roleTitle}`}
          className="block w-full p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed"
        >
          <SessionCardBody
            session={session}
            selectMode
            selected={selected}
          />
        </button>
      </Card>
    );
  }

  return (
    <Card className={cn(CARD_HOVER, "hover:bg-muted/20")}>
      <Link
        href={`/sessions/${session.id}`}
        className="block p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={`Open session: ${session.companyName} ${session.roleTitle}`}
      >
        <SessionCardBody
          session={session}
          selectMode={false}
          selected={false}
        />
      </Link>
    </Card>
  );
}
