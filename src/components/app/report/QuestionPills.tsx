import { MessageCircle, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { QuestionCovered } from "@/lib/llm";

/**
 * Confidence / source pills rendered on every row of the merged
 * "Questions" tab. They give a candidate scanning the per-
 * question list the immediate read on:
 *
 *   - how sure the model is the question was actually asked
 *     (`QuestionConfidencePill`); and
 *   - where the question came from — a candidate-confirmed
 *     artifact or an inferred transcript snippet
 *     (`QuestionSourcePill`).
 *
 * The pills live in their own module (rather than inlined in
 * `MergedQuestionRow`) so the colour / glyph grammar stays
 * consistent if we add additional surfaces later (e.g. the
 * artifact review screen).
 */

/**
 * Color-coded confidence band. Mirrors the traffic-light hierarchy
 * the review-screen `ConfidencePill` uses so the candidate sees a
 * consistent visual grammar across the review, report, and
 * analytics surfaces.
 */
export function QuestionConfidencePill({
  confidence,
}: {
  confidence: QuestionCovered["confidence"];
}) {
  const styles: Record<QuestionCovered["confidence"], string> = {
    high: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-100",
    medium:
      "bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100",
    low: "bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-200",
  };
  const label: Record<QuestionCovered["confidence"], string> = {
    high: "High confidence",
    medium: "Medium confidence",
    low: "Low confidence",
  };
  return (
    <Badge variant="secondary" className={styles[confidence]}>
      {label[confidence]}
    </Badge>
  );
}

/**
 * Source pill — distinguishes "the candidate confirmed this" from
 * "we inferred this from the transcript". The latter inherits the
 * same blue / sparkle treatment Haiku-inferred suggestions get on
 * the review screen so the candidate immediately recognises the
 * framing.
 */
export function QuestionSourcePill({
  source,
}: {
  source: QuestionCovered["source"];
}) {
  if (source === "candidate_confirmed") {
    return (
      <Badge
        variant="secondary"
        className="bg-emerald-100 text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-100"
      >
        <MessageCircle className="size-3" aria-hidden />
        You confirmed
      </Badge>
    );
  }
  return (
    <Badge
      variant="secondary"
      className="bg-blue-100 text-blue-900 dark:bg-blue-900/60 dark:text-blue-100"
    >
      <Sparkles className="size-3" aria-hidden />
      Transcript-inferred
    </Badge>
  );
}
