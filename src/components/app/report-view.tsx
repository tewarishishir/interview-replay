"use client";

import {
  Award,
  CheckCircle2,
  Compass,
  Lightbulb,
  Loader2,
  Mic,
  MessageSquareQuote,
  Quote,
  Wrench,
} from "lucide-react";
import {
  IconAward,
  IconBolt,
  IconCode,
  IconFileText,
  IconListCheck,
  IconMicrophone,
  IconNotes,
  IconSitemap,
  IconUserCircle,
} from "@tabler/icons-react";
import { Suspense, lazy } from "react";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { RebuildLauncher } from "@/components/app/rebuild-launcher";
import { SpeechPaceGauge } from "@/components/app/report/SpeechPaceGauge";
import { StoryHighlightCard } from "@/components/app/report/StoryHighlightCard";
import type { Improvement, Report } from "@/lib/llm";
import {
  countRebuildEligible,
  isRebuildEligible,
  orientationNoteCopy,
} from "@/lib/llm/rebuild-eligibility";
import type { InterviewRoundType } from "@/lib/db/schema";

/**
 * Lazy-loaded merged "Questions covered & Analytics" tab. Pulls
 * in the aggregate chart subtree (STAR / answer length / time
 * distribution) plus the merged per-question list (coverage pills
 * + STAR badges + Rebuild button on a single row). Deferring the
 * import keeps the initial report bundle paint-stable: the
 * Suspense fallback renders inside the tab panel only.
 *
 * The tab uses `forceMount` (unlike the previous Analytics tab)
 * so the question list — the load-bearing recap candidates rely
 * on in print — is captured in the PDF export. The aggregate
 * charts themselves are still excluded from print via a
 * `print:hidden` wrapper inside the orchestrator (charts don't
 * render well in print). The trade-off: the lazy import now fires
 * on first report render rather than on tab click. Acceptable
 * given the bundle's heavy parts (chart subtrees) are still
 * split off.
 */
const QuestionsAndAnalyticsTab = lazy(() =>
  import("@/components/app/report/QuestionsAndAnalyticsTab").then((m) => ({
    default: m.QuestionsAndAnalyticsTab,
  })),
);

interface ReportViewProps {
  report: Report;
  roundType: InterviewRoundType;
  /**
   * Source session id. Required for the inline "Rebuild a story
   * for this →" launchers under each rebuild-eligible improvement
   * — they pre-fill the new rebuild's `source_session_id` and
   * `source_improvement_index` so the banner on Step 1 of the
   * rebuild flow can render the "You're rebuilding an answer for
   * X" copy.
   *
   * Left optional so unit tests / Storybook stories can render
   * the report without wiring rebuilds. When unset, every inline
   * button silently disappears AND the orientation note above the
   * Improvements list is hidden — the report still reads fine
   * end to end.
   */
  sessionId?: string;
  /**
   * Render in read-only "historical" mode for the
   * `/sessions/:id/reports/:reportId` page. Re-analyses no longer
   * overwrite the prior report — the user can navigate back to an
   * earlier version. Those views suppress every write-affordance
   * (the inline rebuild launchers + the orientation note above
   * Improvements) because:
   *   - The improvement indices in an old report are unstable
   *     across re-runs, so launching a rebuild from a stale list
   *     would attach the wrong `source_improvement_index`.
   *   - Rebuilds are FK'd by session, not by report version, so
   *     there's no audit trail tying a rebuild to "the report I
   *     was looking at when I clicked".
   * The current report (via the session detail page) keeps the
   * launchers; only the historical viewer hides them.
   */
  isHistorical?: boolean;
  /**
   * Round-level transcript stats used by the speech pace gauge at
   * the top of the Communication section. Optional because:
   *   - Storybook / unit-harness renders may not have a transcript
   *     row joined in (the rest of the report still renders fine).
   *   - Pre-transcribe sessions can theoretically render the
   *     report shell with no transcript yet (in practice the
   *     report row doesn't exist until after transcribe completes,
   *     but the type stays defensive).
   *
   * When omitted OR when either field is 0, the gauge silently
   * returns null and the Communication section renders without it.
   */
  transcript?: {
    wordCount: number;
    durationSeconds: number;
  } | null;
  /**
   * `reports.created_at` of the report row being rendered. Used by
   * the merged Questions covered & Analytics tab to disambiguate
   * the two `items === undefined` cases (legacy report vs. post-
   * launch report with the field suppressed by the LLM); see
   * `QuestionsAndAnalyticsTab`'s `reportCreatedAt` JSDoc for the
   * full rationale.
   *
   * Optional so Storybook / harness renders don't have to plumb a
   * date through. The merged tab's placeholder branch
   * conservatively assumes "legacy" when this is null, matching
   * the pre-existing behavior.
   */
  reportCreatedAt?: Date | null;
  /**
   * Render in read-only "sample mode" for the public /sample-report
   * marketing page. When true, all write-affordances that require
   * auth (rebuild launchers, orientation note) are suppressed by
   * treating the session as having no source session id — visually
   * identical to a historical read-only view but without the
   * "historical report" semantics.
   *
   * Defaults to false so the authenticated session view is unchanged.
   */
  isSampleMode?: boolean;
}

/**
 * Tabbed report layout. Six load-bearing blocks per spec, surfaced
 * one tab at a time so the candidate doesn't have to scroll a 6-
 * section wall. An always-visible "AI Read" headline sits
 * ABOVE the tab strip so the candidate sees the verdict + readiness
 * gauge before picking a section to drill into:
 *
 *   0. AI Read                 — boxed one-paragraph take +
 *                                       readiness gauge. Rendered
 *                                       OUTSIDE the Tabs root and at
 *                                       the TOP of the article so it's
 *                                       always visible (and is the
 *                                       first block of the print/PDF
 *                                       export). This block intentionally
 *                                       moved from the bottom of the
 *                                       article — the headline take is
 *                                       what the candidate is here for;
 *                                       burying it under six tabs forced
 *                                       a scroll to find it.
 *   1. Executive summary             — large + prominent (default tab)
 *   2. Strengths                     — list with quotes
 *   3. Improvements                  — list with concrete next-step actions
 *   4. Communication                 — pace / fillers / structure / presence
 *   5. Round-specific                — varies by round_type
 *   6. Questions covered & Analytics — aggregate charts +
 *                                      per-question list (conditional)
 *
 * The Questions covered & Analytics tab is a merge of what used
 * to be two separate tabs ("Questions covered" + "Analytics") —
 * the per-question list now carries both the coverage framing
 * (confidence + source pills + evidence quote) and the analytics
 * framing (STAR badges, fillers/min, profile leverage, Rebuild
 * button) on a single row, with the aggregate charts above.
 *
 * Print stylesheet (globals.css) forces every tab content visible
 * during print so PDF export captures the full report; the tab
 * list itself is hidden in print via `print:hidden`. Each
 * `TabsContent` uses `forceMount` so inactive sections are mounted
 * (with the `hidden` HTML attribute) — the print rule then flips
 * those to `display: block` so nothing is missed in the export.
 * The aggregate charts inside the merged tab are individually
 * `print:hidden` — they don't render well in print and the list
 * below carries the question recap on its own.
 */
export function ReportView({
  report,
  roundType,
  sessionId,
  isHistorical = false,
  isSampleMode = false,
  transcript = null,
  reportCreatedAt = null,
}: ReportViewProps) {
  // Pre-computed once so the orientation note's count and the
  // per-card render decision read from the same numbers. The
  // `rebuildSessionId` gate is the load-bearing "the launcher
  // needs a source session id to wire `source_session_id` into
  // the rebuild row" check; without one (e.g. a Storybook render
  // OR a future caller that accidentally passes `""`), we
  // silently skip the inline button on every card AND the
  // orientation note above the list. Normalising the sessionId
  // prop to `string | null` here is the single source of truth
  // every gate below reads from — keeping the orientation note
  // and the per-card buttons in lockstep is the load-bearing
  // invariant (otherwise the note can claim "2 of 5 improvements
  // below…" while no buttons render).
  //
  // `isHistorical` short-circuits the gate to null regardless of
  // sessionId — the historical viewer must not surface rebuild
  // launchers tied to potentially-stale improvement indices (see
  // the prop's JSDoc for the full rationale).
  const rebuildSessionId =
    !isHistorical &&
    !isSampleMode &&
    typeof sessionId === "string" &&
    sessionId.length > 0
      ? sessionId
      : null;
  const eligibility = countRebuildEligible(report.improvements);
  const showRebuildAffordances =
    rebuildSessionId !== null && eligibility.eligible > 0;

  // The Questions tab is always shown — `QuestionsAndAnalyticsTab`
  // already handles every empty-data state with a graceful placeholder
  // (legacy copy + re-analyze CTA). Hiding the tab trigger was the
  // original design, but it caused silent data-loss UX: when the
  // analytics parallel call failed (e.g. token-cap exceeded for a long
  // session) the tab simply disappeared with no explanation. Now users
  // always see the tab; if questions couldn't be extracted they see a
  // clear message and a re-analyze link.

  return (
    <article className="space-y-10 print:space-y-8" data-slot="report">
      {/*
        AI Read — rendered ABOVE the tab strip so the candidate
        lands on the headline take + readiness gauge immediately, before
        choosing which detailed section to drill into. Sits outside the
        Tabs root on purpose: it's the always-visible verdict of the
        report (and the always-visible top block of the print/PDF
        export), not a tab-gated detail panel.
      */}
      <section
        aria-labelledby="ir-read-heading"
        id="ir-read-full"
      >
        <h2
          id="ir-read-heading"
          className="flex items-center gap-2 text-lg font-semibold tracking-tight"
        >
          <MessageSquareQuote className="size-4" aria-hidden />
          The AI Read
        </h2>
        <div className="mt-4 rounded-xl border-2 border-primary/40 bg-primary/[0.03] p-6">
          {typeof report.aiRead.readinessScore === "number" && (
            <ReadinessMeter score={report.aiRead.readinessScore} />
          )}
          <p className="text-base leading-relaxed text-foreground">
            {report.aiRead.paragraph}
          </p>
        </div>
      </section>

      <Tabs defaultValue="summary" className="w-full gap-6">
        {/*
          The shared `TabsList` clamps to `h-9` for horizontal
          orientation. When a wide-label set like ours (six tabs,
          Executive summary + Questions) wraps to a second row on
          narrower viewports, that fixed height made the second
          row overflow the strip and collide with the panel
          below — see the bug report screenshot. `h-auto!`
          overrides the variant-prefixed `h-9` so the list grows
          with however many rows the labels need (Tailwind v4
          important suffix; the prefixed class can't otherwise be
          beaten by twMerge).

          Visual differentiation from the global app-header nav
          (per the visual-refinement spec): the report tab strip
          uses a SUBTLE UNDERLINE below the active tab — a 2px
          accent border at the bottom that signals "you are
          here" without competing with the global nav's pill
          styling. The icons stay coloured to preserve the
          per-tab colour identity (Summary blue, Strengths
          emerald, etc.); the underline picks up the same colour
          family for cohesion.

          A persistent thin border-bottom on the LIST itself
          gives the underline a continuous baseline so the
          active-tab accent reads as "selected from a group",
          not as a floating 2px line. We DON'T use the shared
          `variant="line"` — its `after:` pseudo-underline at
          `bottom: -5px` would bleed into a second row when the
          list wraps on narrow viewports.
        */}
        <TabsList
          aria-label="Report sections"
          data-print-hide
          data-testid="report-tabs-list"
          className="flex h-auto! w-full flex-wrap items-end justify-start gap-1 rounded-none border-b border-border bg-transparent p-0 print:hidden"
        >
          <TabsTrigger
            value="summary"
            className="flex-none gap-1.5 rounded-none border-b-2 border-transparent bg-transparent! px-2 py-2 text-foreground/70 shadow-none! hover:text-foreground data-[state=active]:border-blue-500 data-[state=active]:text-blue-800 dark:data-[state=active]:border-blue-400 dark:data-[state=active]:text-blue-200"
          >
            <IconFileText
              size={16}
              stroke={1.75}
              className="text-blue-600 dark:text-blue-400"
              aria-hidden
            />
            Executive summary
          </TabsTrigger>
          <TabsTrigger
            value="strengths"
            className="flex-none gap-1.5 rounded-none border-b-2 border-transparent bg-transparent! px-2 py-2 text-foreground/70 shadow-none! hover:text-foreground data-[state=active]:border-emerald-500 data-[state=active]:text-emerald-800 dark:data-[state=active]:border-emerald-400 dark:data-[state=active]:text-emerald-200"
          >
            <IconAward
              size={16}
              stroke={1.75}
              className="text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
            Strengths
          </TabsTrigger>
          {/*
            Stories tab is always visible for behavioral rounds — the
            parallel generateStoryHighlights call can fail silently
            (catch → storyHighlights: []) and hiding the tab gives the
            candidate zero indication that anything went wrong. For
            non-behavioral rounds, [] is the intentional model output
            (the prompt tells the model to emit []) so hiding is correct.
          */}
          {(report.storyHighlights.length > 0 || roundType === "behavioral") && (
            <TabsTrigger
              value="stories"
              className="flex-none gap-1.5 rounded-none border-b-2 border-transparent bg-transparent! px-2 py-2 text-foreground/70 shadow-none! hover:text-foreground data-[state=active]:border-teal-500 data-[state=active]:text-teal-800 dark:data-[state=active]:border-teal-400 dark:data-[state=active]:text-teal-200"
            >
              <IconNotes
                size={16}
                stroke={1.75}
                className="text-teal-600 dark:text-teal-400"
                aria-hidden
              />
              Stories
            </TabsTrigger>
          )}
          <TabsTrigger
            value="improvements"
            className="flex-none gap-1.5 rounded-none border-b-2 border-transparent bg-transparent! px-2 py-2 text-foreground/70 shadow-none! hover:text-foreground data-[state=active]:border-amber-500 data-[state=active]:text-amber-800 dark:data-[state=active]:border-amber-400 dark:data-[state=active]:text-amber-200"
          >
            <IconBolt
              size={16}
              stroke={1.75}
              className="text-amber-600 dark:text-amber-400"
              aria-hidden
            />
            Improvements
          </TabsTrigger>
          <TabsTrigger
            value="communication"
            className="flex-none gap-1.5 rounded-none border-b-2 border-transparent bg-transparent! px-2 py-2 text-foreground/70 shadow-none! hover:text-foreground data-[state=active]:border-violet-500 data-[state=active]:text-violet-800 dark:data-[state=active]:border-violet-400 dark:data-[state=active]:text-violet-200"
          >
            <IconMicrophone
              size={16}
              stroke={1.75}
              className="text-violet-600 dark:text-violet-400"
              aria-hidden
            />
            Communication
          </TabsTrigger>
          <TabsTrigger
            value="round"
            className="flex-none gap-1.5 rounded-none border-b-2 border-transparent bg-transparent! px-2 py-2 text-foreground/70 shadow-none! hover:text-foreground data-[state=active]:border-indigo-500 data-[state=active]:text-indigo-800 dark:data-[state=active]:border-indigo-400 dark:data-[state=active]:text-indigo-200"
          >
            <RoundIcon
              roundType={roundType}
              className="text-indigo-600 dark:text-indigo-400"
            />
            {roundLabel(roundType)}
          </TabsTrigger>
          {/*
            "Questions" — merged rightmost tab (formerly
            "Questions covered & Analytics", renamed for IA
            polish; the value is still `"questions"` so any
            existing URL fragments / analytics event properties
            keying off the slug continue to resolve).
            Hidden only when both the coverage list AND the
            per-question analytics array are empty (the all-
            placeholders state); otherwise the orchestrator
            handles the partial-data branches internally so a
            candidate who has either side gets the full tab.
          */}
          <TabsTrigger
              value="questions"
              className="flex-none gap-1.5 rounded-none border-b-2 border-transparent bg-transparent! px-2 py-2 text-foreground/70 shadow-none! hover:text-foreground data-[state=active]:border-sky-500 data-[state=active]:text-sky-800 dark:data-[state=active]:border-sky-400 dark:data-[state=active]:text-sky-200"
            >
              <IconListCheck
                size={16}
                stroke={1.75}
                className="text-sky-600 dark:text-sky-400"
                aria-hidden
              />
              Questions
            </TabsTrigger>
        </TabsList>

        {/* 1. Executive summary */}
        <TabsContent value="summary" forceMount>
          <section aria-labelledby="exec-summary">
            <h2
              id="exec-summary"
              className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              Executive summary
            </h2>
            <p className="mt-3 text-xl leading-relaxed tracking-tight text-foreground">
              {report.executiveSummary}
            </p>
          </section>
        </TabsContent>

        {/* 2. Strengths */}
        <TabsContent value="strengths" forceMount>
          <section aria-labelledby="strengths-heading">
            <h2
              id="strengths-heading"
              className="flex items-center gap-2 text-lg font-semibold tracking-tight"
            >
              <Award className="size-4" aria-hidden />
              Strengths
            </h2>
            <ul className="mt-4 space-y-6">
              {report.strengths.map((s, i) => (
                <li
                  key={i}
                  className="rounded-xl border border-border bg-background p-5"
                >
                  <h3 className="text-base font-semibold">{s.heading}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-foreground/80">
                    {s.detail}
                  </p>
                  {s.evidence.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {s.evidence.map((e, j) => (
                        <li
                          key={j}
                          className="flex gap-2 border-l-2 border-primary/40 pl-3 text-sm italic"
                          style={{ color: "var(--color-text-primary)" }}
                        >
                          <Quote
                            className="mt-0.5 size-3.5 shrink-0 text-primary/60"
                            aria-hidden
                          />
                          <span>{e.quote}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </TabsContent>

        {/* 3. Story highlights */}
        {(report.storyHighlights.length > 0 || roundType === "behavioral") && (
          <TabsContent value="stories" forceMount>
            {report.storyHighlights.length > 0 ? (
              <section aria-labelledby="stories-heading">
                <h2
                  id="stories-heading"
                  className="flex items-center gap-2 text-lg font-semibold tracking-tight"
                >
                  <IconNotes size={18} stroke={1.75} aria-hidden />
                  Story highlights
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Stories worth developing further, and stories worth retiring.
                </p>
                <ul className="mt-4 space-y-4">
                  {report.storyHighlights.map((s, i) => (
                    <li key={i}>
                      <StoryHighlightCard story={s} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <div
                className="rounded-xl border border-border bg-background p-6 text-sm"
                role="status"
              >
                <p className="text-muted-foreground">
                  Story highlights weren&apos;t generated for this session.
                </p>
                {!isHistorical && sessionId && (
                  <p className="mt-3 text-muted-foreground">
                    <a
                      href={`/sessions/${sessionId}/edit`}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      Edit &amp; re-analyze →
                    </a>{" "}
                    to try again.
                  </p>
                )}
              </div>
            )}
          </TabsContent>
        )}

        {/* 4. Improvements */}
        <TabsContent value="improvements" forceMount>
          <section aria-labelledby="improvements-heading">
            <h2
              id="improvements-heading"
              className="flex items-center gap-2 text-lg font-semibold tracking-tight"
            >
              <Wrench className="size-4" aria-hidden />
              Improvements
            </h2>
            {/*
              Orientation note. Only renders when at least one
              improvement is rebuild-eligible AND the report has a
              source session id wired up — otherwise the count would
              point at affordances that don't render. Hidden in print
              for the same reason the inline buttons are: the printable
              report is the analysis, not the rebuild flow.
            */}
            {showRebuildAffordances && (
              <p className="mt-3 text-sm text-muted-foreground print:hidden">
                {orientationNoteCopy(eligibility)}
              </p>
            )}
            {report.improvements.length > 0 && (
              <div
                role="note"
                className="mt-4 flex items-start gap-3 print:hidden"
                style={{
                  background: "var(--color-bg-secondary)",
                  padding: "12px 16px",
                  borderRadius: "var(--border-radius-md, 8px)",
                  borderLeft: "3px solid var(--color-ir-gold)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    color: "var(--color-ir-gold)",
                    fontSize: "16px",
                    lineHeight: 1,
                    marginTop: "2px",
                    flexShrink: 0,
                  }}
                >
                  →
                </span>
                <div style={{ fontSize: "13px" }}>
                  <strong
                    style={{
                      fontWeight: 500,
                      color: "var(--color-text-primary)",
                      display: "block",
                    }}
                  >
                    If you only fix one thing before your next interview, fix #1.
                  </strong>
                  <span style={{ color: "var(--color-text-secondary)" }}>
                    The first improvement below is the highest-leverage change — it will compound across every other answer.
                  </span>
                </div>
              </div>
            )}
            <ul className="mt-4 space-y-6">
              {report.improvements.map((m, i) => (
                <li
                  key={i}
                  className="rounded-xl border border-border bg-background p-5"
                  style={
                    i === 0
                      ? { borderLeft: "3px solid var(--color-ir-gold)" }
                      : undefined
                  }
                >
                  <h3 className="text-base font-semibold">{m.heading}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-foreground/80">
                    {m.detail}
                  </p>
                  <div className="mt-3 flex items-start gap-2 rounded-md bg-muted/60 p-3 text-sm">
                    <Lightbulb
                      className="mt-0.5 size-4 shrink-0 text-amber-600"
                      aria-hidden
                    />
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Try this next time
                      </span>
                      <p className="mt-1 text-foreground/90">{m.action}</p>
                    </div>
                  </div>
                  {m.evidence.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {m.evidence.map((e, j) => (
                        <li
                          key={j}
                          className="flex gap-2 border-l-2 border-amber-400/50 pl-3 text-sm italic"
                          style={{ color: "var(--color-text-primary)" }}
                        >
                          <Quote
                            className="mt-0.5 size-3.5 shrink-0 text-amber-500/70"
                            aria-hidden
                          />
                          <span>{e.quote}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {rebuildSessionId !== null && isRebuildEligible(m) && (
                    <div className="mt-4 print:hidden">
                      <RebuildLauncher
                        source="report_inline"
                        payload={{
                          source_session_id: rebuildSessionId,
                          source_improvement_index: i,
                          question_text: seedQuestionText(m),
                        }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </TabsContent>

        {/* 4. Communication signals */}
        <TabsContent value="communication" forceMount>
          <section aria-labelledby="comms-heading">
            <h2
              id="comms-heading"
              className="flex items-center gap-2 text-lg font-semibold tracking-tight"
            >
              <Mic className="size-4" aria-hidden />
              Communication signals
            </h2>

            {/*
              Speech pace gauge — visual headline for the section.
              Sits above the four signal cards so the round-level
              wpm is the first thing the candidate's eye lands on
              when they open the tab; the per-signal narrative
              prose below adds context the gauge can't carry on its
              own (filler patterns, structural / presence reads).
              Returns null on zero-duration / zero-word transcripts
              so the section still reads correctly when the
              recording was effectively silent.

              We DELIBERATELY drop the old "~X wpm" footer on the
              Pace SignalCard now that the gauge is the canonical
              wpm surface — duplicating the number in two places
              invited drift the moment the gauge ever used a
              different denominator than the report's prose summary.
            */}
            {transcript && (
              <div className="mt-6 flex justify-center">
                <SpeechPaceGauge
                  wordCount={transcript.wordCount}
                  durationSeconds={transcript.durationSeconds}
                  sessionId={sessionId ?? null}
                />
              </div>
            )}

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <SignalCard
                title="Pace"
                body={report.communicationSignals.pace.summary}
              />
              <SignalCard
                title="Filler words"
                body={report.communicationSignals.fillerWords.summary}
                footer={
                  report.communicationSignals.fillerWords.topOffenders.length >
                  0
                    ? `Top: ${report.communicationSignals.fillerWords.topOffenders.join(", ")}`
                    : null
                }
              />
              <SignalCard
                title="Structure"
                body={report.communicationSignals.structure.summary}
              />
              <SignalCard
                title="Presence"
                body={report.communicationSignals.presence.summary}
              />
            </div>
          </section>
        </TabsContent>

        {/* 5. Round-specific */}
        <TabsContent value="round" forceMount>
          <section aria-labelledby="round-heading">
            <h2
              id="round-heading"
              className="flex items-center gap-2 text-lg font-semibold tracking-tight"
            >
              <Compass className="size-4" aria-hidden />
              {roundLabel(roundType)} — round detail
            </h2>
            <div className="mt-4 space-y-3">
              <RoundSpecificView report={report} />
            </div>
          </section>
        </TabsContent>

        {/*
          6. Questions covered & Analytics. Merged from the
          previous two tabs (Questions covered + Analytics) — the
          orchestrator renders aggregate charts at the top and a
          unified per-question list below (coverage pills +
          evidence quote + STAR badges + Rebuild button per row).

          `forceMount` so the question list participates in the
          print export. The aggregate charts inside the
          orchestrator are wrapped in `print:hidden` because they
          don't render well in print. The Suspense fallback only
          shows on first paint until the lazy chunk loads.
        */}
        <TabsContent value="questions" forceMount>
            <Suspense
              fallback={
                <div
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Loading questions &amp; analytics…
                </div>
              }
            >
              <QuestionsAndAnalyticsTab
                items={report.per_question_analytics}
                questionsCovered={report.questionsCovered}
                sessionId={sessionId ?? null}
                isHistorical={isHistorical}
                reportCreatedAt={reportCreatedAt}
              />
            </Suspense>
          </TabsContent>
      </Tabs>
    </article>
  );
}

/**
 * Readiness gauge surfaced at the top of the AI Read box.
 *
 * The score (0-100) is a coaching signal — how prepared the candidate
 * looked for THIS round at THEIR stated level — not a probability of
 * being hired. The tier label and color are derived client-side from
 * the same calibration anchors the system prompt uses, so the rubric
 * stays consistent across reports even if a future prompt revision
 * tweaks the score wording.
 */
function ReadinessMeter({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const tier = readinessTier(clamped);

  return (
    <div className="mb-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Readiness
          </span>
          <span
            className={`text-xs font-medium ${tier.textClass}`}
            aria-hidden
          >
            {tier.label}
          </span>
        </div>
        <div className="tabular-nums">
          <span className={`text-2xl font-semibold ${tier.textClass}`}>
            {clamped}
          </span>
          <span className="ml-0.5 text-xs text-muted-foreground">/100</span>
        </div>
      </div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-label={`Readiness ${clamped} out of 100 — ${tier.label}`}
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full transition-[width] ${tier.barClass}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        How prepared this round looked at your stated level — not a
        prediction of pass/fail.
      </p>
    </div>
  );
}

interface ReadinessTier {
  label: string;
  textClass: string;
  barClass: string;
}

function readinessTier(score: number): ReadinessTier {
  if (score < 20) {
    return {
      label: "Foundational gaps",
      textClass: "text-rose-700",
      barClass: "bg-rose-500",
    };
  }
  if (score < 40) {
    return {
      label: "Early",
      textClass: "text-rose-700",
      barClass: "bg-rose-400",
    };
  }
  if (score < 60) {
    return {
      label: "Building",
      textClass: "text-amber-700",
      barClass: "bg-amber-400",
    };
  }
  if (score < 75) {
    return {
      label: "On track",
      textClass: "text-yellow-700",
      barClass: "bg-yellow-400",
    };
  }
  if (score < 90) {
    return {
      label: "Strong",
      textClass: "text-emerald-700",
      barClass: "bg-emerald-500",
    };
  }
  return {
    label: "Excellent",
    textClass: "text-emerald-700",
    barClass: "bg-emerald-600",
  };
}

function SignalCard({
  title,
  body,
  footer,
}: {
  title: string;
  body: string;
  footer?: string | null;
}) {
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-foreground/80">{body}</p>
      {footer && (
        <p className="mt-3 text-xs text-muted-foreground">{footer}</p>
      )}
    </div>
  );
}

function roundLabel(t: InterviewRoundType): string {
  switch (t) {
    case "coding":
      return "Coding";
    case "system_design":
      return "System design";
    case "behavioral":
      return "Behavioral";
    case "other":
      return "Other";
  }
}

/**
 * Per-round-type tab icon. Pulled from the Tabler outline family
 * for visual consistency with the other tab icons (`IconFileText`,
 * `IconAward`, etc.). All sized to 16px with the same stroke
 * weight so the tab strip reads as one set:
 *
 *   - behavioral    → user-circle (the round is about the person)
 *   - coding        → code        (literal — code typed)
 *   - system_design → sitemap     (architectural diagram)
 *   - other         → user-circle (sensible default)
 */
function RoundIcon({
  roundType,
  className,
}: {
  roundType: InterviewRoundType;
  className?: string;
}) {
  const props = {
    size: 16,
    stroke: 1.75,
    className,
    "aria-hidden": true,
  } as const;
  switch (roundType) {
    case "coding":
      return <IconCode {...props} />;
    case "system_design":
      return <IconSitemap {...props} />;
    case "behavioral":
    case "other":
      return <IconUserCircle {...props} />;
  }
}

function RoundSpecificView({ report }: { report: Report }) {
  const r = report.roundSpecific;
  switch (r.kind) {
    case "coding":
      return (
        <>
          <Subsection title="Problem framing" body={r.problemFraming} />
          <Subsection title="Solution exploration" body={r.solutionExploration} />
          <Subsection title="Implementation hygiene" body={r.implementationHygiene} />
          <Subsection title="Verification" body={r.verification} />
          <Subsection title="Recovery from feedback" body={r.recoveryFromFeedback} />
        </>
      );
    case "system_design":
      return (
        <>
          <Subsection title="Requirements gathering" body={r.requirementsGathering} />
          <Subsection title="High-level design" body={r.highLevelDesign} />
          <Subsection title="Deep-dives" body={r.deepDives} />
          <Subsection
            title="Trade-offs and failure modes"
            body={r.tradeOffsAndFailureModes}
          />
          <Subsection title="Scaling story" body={r.scalingStory} />
        </>
      );
    case "behavioral":
      return (
        <>
          <Subsection title="STAR completeness" body={r.starCompleteness} />
          <Subsection title="Specificity" body={r.specificity} />
          <Subsection title="Self-awareness" body={r.selfAwareness} />
          <Subsection title="Leadership signals" body={r.leadershipSignals} />
        </>
      );
    case "other":
      return (
        <>
          <Subsection title="Understanding" body={r.understanding} />
          <Subsection title="Structure" body={r.structure} />
          <Subsection title="Reasoning" body={r.reasoning} />
          <Subsection title="Engagement" body={r.engagement} />
        </>
      );
  }
}


function Subsection({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <CheckCircle2 className="size-4 text-primary" aria-hidden />
        {title}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-foreground/80">{body}</p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Rebuild integration                                            */
/* ────────────────────────────────────────────────────────────── */

/**
 * Best-effort seed for the rebuild's `question_text` field. The
 * report doesn't link improvements back to specific questions, so
 * we use the improvement's heading — the user sees this as the
 * Step 1 banner copy and can use it as the framing for the answer
 * they're rebuilding.
 *
 * Truncated to 1000 chars (the API edge cap) defensively; report
 * headings are usually well under 100 chars but a malformed report
 * with a runaway heading shouldn't cause the create call to 400.
 *
 * Eligibility itself (which improvements get the rebuild button)
 * is a model-side decision now — see `improvement.rebuildEligible`
 * and the helpers in `@/lib/llm/rebuild-eligibility`. The previous
 * keyword-based heuristic lived here; it was removed when the
 * "Strengthen your story bank" bottom section was folded into
 * inline per-card buttons (the model has the round type, story
 * shape, and full context — a regex over the heading either over-
 * triggered on coding-round comments mentioning "we", or under-
 * triggered on rebuild-worthy improvements phrased without any
 * trigger word).
 */
function seedQuestionText(m: Improvement): string {
  const seed = m.heading.trim();
  return seed.length > 1000 ? seed.slice(0, 1000) : seed;
}

