"use client";

import { HelpCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  Component,
  useCallback,
  useEffect,
  useState,
  useTransition,
} from "react";

import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import type { PerQuestionAnalytics, QuestionCovered } from "@/lib/llm";

import { AnswerLengthDistribution } from "./AnswerLengthDistribution";
import { MergedQuestionsList } from "./PerQuestionBreakdown";
import { StarCompletenessBars } from "./StarCompletenessBars";
import { deriveTabMountProperties, isPostLaunchReport } from "./analytics-utils";

export interface QuestionsAndAnalyticsTabProps {
  /**
   * The validated `per_question_analytics` array off the report.
   * `undefined` for reports persisted before the feature shipped —
   * the orchestrator falls back to the legacy placeholder (or
   * coverage-only list when `questionsCovered` is present).
   */
  items: ReadonlyArray<PerQuestionAnalytics> | undefined;
  /**
   * `questionsCovered` from the same report. Drives the pill +
   * evidence-quote portion of each merged row. Optional with `[]`
   * as the default for Storybook / harness renders.
   */
  questionsCovered?: ReadonlyArray<QuestionCovered>;
  /**
   * Owning session id. Required for the rebuild launchers and the
   * Re-analyze CTA on the legacy placeholder. `null` for
   * Storybook / harness renders and for historical viewers — the
   * rebuild + re-analyze affordances all disappear.
   */
  sessionId: string | null;
  /**
   * Read-only "historical" mode (the `/sessions/:id/reports/:rid`
   * page). Charts still render because the data is immutable, but
   * the rebuild buttons + Re-analyze CTA all disappear (re-runs
   * from a historical page would attach to potentially-stale
   * improvement indices — see `report-view.tsx` for the full
   * rationale).
   */
  isHistorical?: boolean;
  /**
   * `created_at` of the report row. Used purely to disambiguate
   * the two `items === undefined` cases (legacy vs. post-launch
   * empty) in the placeholder branches. Optional; harness renders
   * fall through to the legacy branch when this is null.
   */
  reportCreatedAt?: Date | null;
}

/**
 * Top-level "Questions covered & Analytics" tab.
 *
 * Merges what used to be two tabs (Questions covered + Analytics)
 * into a single surface so the per-question list isn't duplicated:
 *
 *   1. Aggregate charts (STAR completeness, answer length, time
 *      distribution) at the top, wrapped in `print:hidden` so the
 *      PDF export keeps reading cleanly (the charts don't render
 *      well in print and the rest of the report fills the gap).
 *   2. A unified per-question list below — each row pairs the
 *      coverage data (confidence + source + evidence quote) with
 *      the analytics data (STAR badges, fillers/min, I/we counts,
 *      profile leverage, Rebuild button).
 *
 * Render branches:
 *
 *   - `items === undefined` AND `questionsCovered` empty: render
 *     the placeholder (legacy vs. post-launch determined by
 *     `reportCreatedAt`).
 *   - `items` empty AND `questionsCovered` empty: render the
 *     "no questions identified" placeholder.
 *   - either array non-empty: render the charts (when analytics
 *     is non-empty) + the merged list.
 *
 * The charts use a per-section error boundary so one bad chart
 * doesn't take the whole tab down with it (per spec; matches the
 * pre-merge behavior of `AnalyticsTab`).
 */
export function QuestionsAndAnalyticsTab({
  items,
  questionsCovered,
  sessionId,
  isHistorical = false,
  reportCreatedAt = null,
}: QuestionsAndAnalyticsTabProps) {
  useEffect(() => {
    // Analytics event placeholder (external tracking removed).
  }, [sessionId, items]);

  const handleCardClick = useCallback(
    (item: PerQuestionAnalytics | null, index: number) => {

      // Coverage-only rows have no `artifact_id` and no analytics
      // entry to event from — we skip the anchor scroll for them.
      // The orchestrator still dispatches the custom event in
      // case a future on-page transcript subscribes to it for
      // coverage-only highlights.
      if (typeof document !== "undefined") {
        if (item?.artifact_id) {
          const anchor = document.getElementById(
            `artifact-${item.artifact_id}`,
          );
          if (anchor) {
            anchor.scrollIntoView({ behavior: "smooth", block: "center" });
            anchor.setAttribute("data-highlight", "true");
            window.setTimeout(() => {
              anchor.removeAttribute("data-highlight");
            }, 1600);
          }
        }
        try {
          document.dispatchEvent(
            new CustomEvent("analytics:question-clicked", {
              detail: {
                artifactId: item?.artifact_id ?? null,
                index,
              },
            }),
          );
        } catch {
          // CustomEvent isn't constructable in some legacy
          // environments — the merged tab is desktop-only so this
          // path effectively never fires, but the try/catch keeps
          // the scroll behavior alive if it ever does.
        }
      }
    },
    [sessionId],
  );

  const handleRebuildClick = useCallback(
    (
      _item: PerQuestionAnalytics,
      _index: number,
      _source: "card_button" | "profile_indicator",
    ) => {
      // Analytics event placeholder (external tracking removed).
    },
    [sessionId],
  );

  const hasCoverage = (questionsCovered?.length ?? 0) > 0;
  const hasAnalytics = items !== undefined && items.length > 0;

  // No data on either side → fall through to the placeholders the
  // pre-merge Analytics tab used. The legacy / post-launch
  // disambiguation still applies because re-analyze CTA semantics
  // are unchanged — we just gate it on "no coverage AND no
  // analytics" rather than "no analytics".
  //
  // `hasAnalytics` itself is also consumed in the JSX below — TS
  // narrows on `items !== undefined && items.length > 0` inline
  // there rather than on this boolean so the chart components
  // receive a non-optional array prop.
  if (!hasCoverage && !hasAnalytics) {
    if (items === undefined) {
      return (
        <LegacyReportPlaceholder
          sessionId={sessionId}
          isHistorical={isHistorical}
          reportCreatedAt={reportCreatedAt}
        />
      );
    }
    return <EmptyQuestionsPlaceholder sessionId={sessionId} />;
  }

  return (
    <section
      aria-labelledby="merged-tab-heading"
      data-testid="questions-and-analytics-tab"
    >
      <h2
        id="merged-tab-heading"
        className="flex items-center gap-2 text-lg font-semibold tracking-tight"
      >
        <HelpCircle className="size-4" aria-hidden />
        Questions
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Every distinct question we identified across your round, with how
        confident we are about each. The aggregate charts above summarise
        STAR completeness, answer length, and where time went.
      </p>

      {/* Aggregate charts. Wrapped in `print:hidden` so the PDF
          export stays readable — charts don't render well in
          print, and the question list below carries the load-
          bearing recap on its own. The `items !== undefined`
          check (rather than `hasAnalytics`) narrows the type so
          the chart components receive a `ReadonlyArray<>` rather
          than `... | undefined`. */}
      {items !== undefined && items.length > 0 && (
        <div
          className="mt-6 flex flex-col print:hidden"
          style={{ gap: "32px" }}
          data-testid="analytics-charts"
        >
          <SectionFrame>
            <SectionErrorBoundary name="STAR completeness">
              <StarCompletenessBars items={items} />
            </SectionErrorBoundary>
          </SectionFrame>
          <SectionFrame>
            {/*
              `AnswerLengthDistribution` now renders ALL questions
              (closing / clarification appear as neutral-coloured
              bars rather than being filtered out), which made the
              former "Time spent on each question" surface
              redundant — it showed the same per-question durations
              without the 90–180s target overlay. Removed in favor
              of this single, more informative chart.
            */}
            <SectionErrorBoundary name="Answer length">
              <AnswerLengthDistribution items={items} />
            </SectionErrorBoundary>
          </SectionFrame>
        </div>
      )}

      {/* Unified per-question list. Renders whenever either side
          has data — the row component itself handles the
          partial-data cases. */}
      <div className="mt-8">
        <MergedQuestionsList
          items={items}
          questionsCovered={questionsCovered}
          sessionId={isHistorical ? null : sessionId}
          onCardClick={handleCardClick}
          onRebuildClick={handleRebuildClick}
        />
      </div>
    </section>
  );
}

/**
 * Visual frame for each chart section: a 0.5px top border so
 * adjacent sections are visibly separated without competing with
 * the bar visuals. The FIRST section's border collapses to 0 via
 * `:first-child` so the tab doesn't start with a redundant rule
 * against the section header above.
 */
function SectionFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="first:pt-0 first:border-t-0"
      style={{
        borderTop: "0.5px solid var(--color-border-tertiary)",
        paddingTop: "24px",
      }}
    >
      {children}
    </div>
  );
}

interface SectionErrorBoundaryState {
  hasError: boolean;
}

/**
 * Minimal error boundary so a chart that throws on bad input
 * doesn't take the rest of the tab down with it. Same shape as
 * the pre-merge `AnalyticsTab` boundary — class-based because
 * React 19 still lacks a hooks API for error boundaries and
 * Suspense fallback only catches load failures, not render-time
 * exceptions.
 */
class SectionErrorBoundary extends Component<
  { children: React.ReactNode; name: string },
  SectionErrorBoundaryState
> {
  override state: SectionErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): SectionErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown) {
    console.warn(
      `[QuestionsAndAnalyticsTab] Section "${this.props.name}" failed to render:`,
      error,
    );
  }

  override render() {
    if (this.state.hasError) {
      return (
        <p
          className="text-muted-foreground"
          style={{ fontSize: "13px" }}
          role="status"
        >
          We couldn&apos;t render the {this.props.name.toLowerCase()} chart.
        </p>
      );
    }
    return this.props.children;
  }
}

/**
 * Placeholder rendered when the report carries neither
 * `per_question_analytics` nor `questionsCovered`. Two sub-
 * branches based on `reportCreatedAt`:
 *
 *   - "legacy" (report predates `ANALYTICS_FEATURE_LAUNCHED_AT`):
 *     the report was generated before the analytics prompt
 *     section existed. Re-analyzing with the current prompt will
 *     populate the section — show the Re-analyze CTA.
 *
 *   - "unavailable" (report is from after the cutoff): the
 *     prompt DID ask for the section and the LLM omitted it
 *     (thin transcript, no anchorable questions, guardrails
 *     stripped every entry). Re-analyzing won't help — same
 *     prompt + same transcript = same outcome. Suppress the CTA
 *     and surface a clearer explanation.
 */
function LegacyReportPlaceholder({
  sessionId,
  isHistorical,
  reportCreatedAt,
}: {
  sessionId: string | null;
  isHistorical: boolean;
  reportCreatedAt: Date | null;
}) {
  if (isPostLaunchReport(reportCreatedAt)) {
    return (
      <div
        className="rounded-xl border border-border bg-background p-6"
        style={{ fontSize: "14px" }}
        role="status"
      >
        <p className="text-muted-foreground">
          We couldn&apos;t identify distinct questions or compute per-
          question analytics for this round. This usually means the
          transcript was too short or too noisy to break into distinct
          questions, or no question artifacts were attached to the session.
          The rest of your report is complete.
        </p>
        {sessionId !== null && !isHistorical && (
          <p className="mt-3 text-muted-foreground">
            <a
              href={`/sessions/${sessionId}/augment`}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Review or add question artifacts &rarr;
            </a>{" "}
            and then re-analyze to try again.
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-border bg-background p-6"
      style={{ fontSize: "14px" }}
      role="status"
    >
      <p className="text-muted-foreground">
        Per-question analytics are available for interviews analyzed after
        this feature shipped. Re-analyze this session to see the breakdown.
      </p>
      {sessionId !== null && !isHistorical && (
        <div className="mt-4">
          <ReanalyzeButton sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}

function EmptyQuestionsPlaceholder({
  sessionId,
}: {
  sessionId: string | null;
}) {
  return (
    <div
      className="rounded-xl border border-border bg-background p-6"
      style={{ fontSize: "14px" }}
      role="status"
    >
      <p className="text-muted-foreground">
        We couldn&apos;t identify distinct questions in this interview. Add
        questions and re-analyze to see the per-question breakdown.
      </p>
      {sessionId !== null && (
        <p className="mt-3 text-muted-foreground">
          <a
            href={`/sessions/${sessionId}/edit`}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Edit transcript and re-analyze &rarr;
          </a>
        </p>
      )}
    </div>
  );
}

/**
 * Inline Re-analyze trigger for the legacy-report placeholder.
 * Same wire shape as the pre-merge `AnalyticsTab`:
 *
 *   - 202: route to the session detail page so the existing
 *     analyzing poller takes over.
 *   - Non-2xx: surface error inline.
 *   - other failure: surface inline; the user can still re-
 *     analyze via the standard session-actions menu.
 *
 * Server-side enforces the "free within 24h of original analysis"
 * pricing rule — the client doesn't need to encode it.
 */
function ReanalyzeButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      let res: Response;
      try {
        res = await fetch(`/api/sessions/${sessionId}/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch {
        setError("Couldn't reach the server. Check your connection.");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        setError(
          body.message ?? `Couldn't start re-analysis (${res.status}).`,
        );
        return;
      }
      router.push(`/sessions/${sessionId}`);
      router.refresh();
    });
  };

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Starting…" : "Re-analyze this session"}
      </button>
      {error && (
        <p
          role="alert"
          className="mt-2 text-xs"
          style={{ color: "var(--color-danger)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
