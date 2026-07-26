"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Quote,
  XCircle,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import type {
  CritiqueResponse,
  DimensionFeedback,
} from "@/lib/rebuilds/schemas";

/**
 * Pure renderer for a validated `CritiqueResponse`. Lifted out of
 * `rebuild-flow.tsx` so the Story Bank page can render the saved
 * critique without re-importing the entire 6-step flow.
 *
 * Two display modes:
 *
 *   - `variant="full"` (default) — the rebuild flow's Step 5 view:
 *     overall assessment + every dimension card + next-step
 *     suggestion, in urgency order. Used in the live rebuild.
 *
 *   - `variant="compact"` — used inside an expander on the Story
 *     Bank card. Same content, same urgency order, but assumes
 *     the surrounding card already has its own header so the
 *     "Critique" h2 is suppressed.
 *
 * The component is presentational only: action buttons (Revise /
 * Save) live in the rebuild-flow caller, not here, so the same
 * component is safe to render on a read-only page.
 */
export interface CritiqueViewProps {
  critique: CritiqueResponse;
  variant?: "full" | "compact";
}

const STATUS_ORDER: Record<DimensionFeedback["status"], number> = {
  missing: 0,
  discrepancy: 1,
  needs_work: 2,
  strong: 3,
};

export function CritiqueView({
  critique,
  variant = "full",
}: CritiqueViewProps) {
  const sorted = useMemo(() => {
    return [...critique.dimension_feedback].sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
    );
  }, [critique.dimension_feedback]);

  return (
    <div
      className={
        variant === "compact" ? "space-y-4" : "space-y-6"
      }
    >
      <div
        className={`rounded-xl border-2 border-primary/30 bg-primary/[0.03] ${
          variant === "compact" ? "p-4" : "p-5"
        }`}
      >
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Overall assessment
        </h3>
        <p className="mt-2 text-sm leading-relaxed sm:text-base">
          {critique.overall_assessment}
        </p>
      </div>

      <ul
        className={variant === "compact" ? "space-y-3" : "space-y-4"}
      >
        {sorted.map((fb, i) => (
          <DimensionCard
            key={`${fb.dimension}-${i}`}
            feedback={fb}
            variant={variant}
          />
        ))}
      </ul>

      <div
        className={`rounded-xl border border-amber-300/60 bg-amber-50/40 ${
          variant === "compact" ? "p-4" : "p-5"
        }`}
      >
        <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <Zap className="size-3.5 text-amber-700" aria-hidden /> Next step
        </h3>
        <p className="mt-2 text-sm leading-relaxed sm:text-base">
          {critique.next_step_suggestion}
        </p>
      </div>
    </div>
  );
}

function DimensionCard({
  feedback,
  variant,
}: {
  feedback: DimensionFeedback;
  variant: "full" | "compact";
}) {
  const meta = STATUS_META[feedback.status];
  const label = DIMENSION_LABELS[feedback.dimension];
  const ref = feedback.profile_reference;
  const padClass = variant === "compact" ? "p-4" : "p-5";

  return (
    <li
      className={`rounded-xl border ${padClass} ${meta.borderClass} ${meta.bgClass}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={meta.iconClass} aria-hidden>
            {meta.icon}
          </span>
          <h3 className="text-base font-semibold">{label}</h3>
        </div>
        <Badge variant="secondary" className={meta.badgeClass}>
          {meta.label}
        </Badge>
      </div>

      {feedback.quoted_excerpt && (
        <p className="mt-3 flex gap-2 border-l-2 border-foreground/30 pl-3 text-sm italic text-muted-foreground">
          <Quote className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>In your draft: &ldquo;{feedback.quoted_excerpt}&rdquo;</span>
        </p>
      )}

      {ref &&
      feedback.dimension === "profile_consistency" &&
      feedback.status === "discrepancy" ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-background p-3 text-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              In your draft you wrote:
            </p>
            <p className="mt-1">&ldquo;{feedback.quoted_excerpt}&rdquo;</p>
          </div>
          <div className="rounded-lg border border-border bg-background p-3 text-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              In your profile under{" "}
              <code className="font-mono">{ref.field_path}</code>:
            </p>
            <p className="mt-1">&ldquo;{ref.field_value}&rdquo;</p>
          </div>
        </div>
      ) : ref && feedback.dimension === "profile_leverage" ? (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Your profile has stronger evidence for this:
          </p>
          <blockquote className="mt-1 rounded-lg border border-border bg-background p-3 text-sm italic">
            &ldquo;{ref.field_value}&rdquo;
          </blockquote>
          <p className="mt-1 text-xs text-muted-foreground">
            Source: <code className="font-mono">{ref.field_path}</code>
          </p>
        </div>
      ) : null}

      <p className="mt-3 text-sm text-foreground/85">{feedback.what_to_check}</p>

      {ref && feedback.dimension === "profile_consistency" && (
        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          <Link
            href="/profile"
            target="_blank"
            className="font-medium underline underline-offset-2"
          >
            Update my profile →
          </Link>
        </div>
      )}
    </li>
  );
}

const DIMENSION_LABELS: Record<DimensionFeedback["dimension"], string> = {
  headline: "Headline",
  star_completeness: "STAR completeness",
  first_person: "First person",
  quantification: "Quantification",
  behavioral_change: "Behavioral change",
  profile_consistency: "Profile consistency",
  profile_leverage: "Profile leverage",
};

const STATUS_META: Record<
  DimensionFeedback["status"],
  {
    label: string;
    icon: React.ReactNode;
    iconClass: string;
    borderClass: string;
    bgClass: string;
    badgeClass: string;
  }
> = {
  strong: {
    label: "Strong",
    icon: <CheckCircle2 className="size-5" />,
    iconClass: "text-emerald-700",
    borderClass: "border-emerald-300/60",
    bgClass: "bg-emerald-50/40",
    badgeClass: "bg-emerald-100 text-emerald-900",
  },
  needs_work: {
    label: "Needs work",
    icon: <CircleAlert className="size-5" />,
    iconClass: "text-amber-700",
    borderClass: "border-amber-300/60",
    bgClass: "bg-amber-50/40",
    badgeClass: "bg-amber-100 text-amber-900",
  },
  missing: {
    label: "Missing",
    icon: <XCircle className="size-5" />,
    iconClass: "text-rose-700",
    borderClass: "border-rose-300/60",
    bgClass: "bg-rose-50/40",
    badgeClass: "bg-rose-100 text-rose-900",
  },
  discrepancy: {
    label: "Discrepancy",
    icon: <AlertTriangle className="size-5" />,
    iconClass: "text-orange-700",
    borderClass: "border-orange-300/60",
    bgClass: "bg-orange-50/40",
    badgeClass: "bg-orange-100 text-orange-900",
  },
};
