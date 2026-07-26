import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Clock,
  FileText,
  Layers,
  Loader2,
} from "lucide-react";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { FALLBACK_MODEL_VERSION_PREFIX, reportSchema } from "@/lib/llm";
import { getSessionForReview } from "@/lib/queries/transcripts";
import { effectiveWordCount } from "@/lib/sessions/effective-transcript";
import { getOutcomeForSession } from "@/lib/sessions/outcomes";
import { OUTCOME_DISPLAY, type OutcomeType as OutcomeDisplayType } from "@/lib/outcomes/colors";
import { AnalysisStepper } from "@/components/app/analysis-stepper";
import { AnalyzingPoller } from "@/components/app/analyzing-poller";
import { CompanyLogo } from "@/components/app/company-logo";
import { ReportView } from "@/components/app/report-view";
import { SessionActions } from "@/components/app/session-actions";
import { RetryButton } from "@/components/app/retry-button";
import {
  type OutcomeCardData,
  type OutcomeType,
} from "@/components/app/outcome-card";
import { OutcomeRow } from "@/components/app/report/OutcomeRow";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";

export const metadata: Metadata = {
  title: "Session report",
};

const paramsSchema = z.object({
  id: z.string().uuid(),
});

type PageProps = {
  params: Promise<{ id: string }>;
};

const formatDuration = (seconds: number): string => {
  if (seconds <= 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

export default async function SessionPage({ params }: PageProps) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { id } = parsed.data;

  const session = await auth();
  if (!session?.user?.id) {
    redirect("/signin");
  }

  // Read session + transcript + artifacts in one bundle. Returns
  // null both for "no row" and "owned by someone else" — same 404
  // both ways so existence isn't disclosed across users.
  const bundle = await getSessionForReview(id, session.user.id);
  if (!bundle) notFound();

  const { session: row, transcript, artifacts } = bundle;

  // Sub-page routing: the detail page IS the report view, but
  // earlier states route to their dedicated UI.
  if (row.state === "review") {
    redirect(`/sessions/${id}/review`);
  }
  if (row.state === "created" || row.state === "recording") {
    redirect(`/sessions/${id}/record`);
  }

  // Fetch reports and outcome in parallel — both are independent of each
  // other and both depend only on the session id we already have.
  // Outcome is only needed for `complete` sessions.
  const [reportRows, outcomeRow] = await Promise.all([
    db
      .select({
        id: schema.reports.id,
        reportJson: schema.reports.reportJson,
        modelVersion: schema.reports.modelVersion,
        rubricVersion: schema.reports.rubricVersion,
        createdAt: schema.reports.createdAt,
      })
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, id))
      .orderBy(desc(schema.reports.createdAt)),
    row.state === "complete" ? getOutcomeForSession(id) : Promise.resolve(null),
  ]);

  const reportRow = reportRows[0] ?? null;

  // The main panel renders `reportRow` only in states where the
  // report itself is the page's primary content (`complete` and any
  // other state that falls through to the ReportView branch below).
  // In `analyzing` and `failed` the main panel intentionally hides
  // it (AnalyzingPanel / FailedPanel render instead) — but the user
  // paid for that report and is entitled to read it. The historical
  // viewer at `/sessions/:id/reports/:reportId` explicitly serves it
  // in those states (see its currency-redirect comments), so we
  // include `reportRows[0]` in the navigable list whenever the main
  // panel isn't rendering it. When the main panel IS rendering it,
  // we exclude index 0 from the list to avoid a self-link.
  const mainPanelRendersCurrentReport =
    reportRow != null &&
    row.state !== "analyzing" &&
    row.state !== "failed";

  const previousReports = (
    mainPanelRendersCurrentReport ? reportRows.slice(1) : reportRows
  ).map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    modelVersion: r.modelVersion,
  }));

  // Validate the stored report against the current schema. A
  // failure here means an old/legacy report shape — we render a
  // graceful fallback rather than crashing the page. The validated
  // path is the common one.
  const parsedReport = reportRow
    ? reportSchema.safeParse(reportRow.reportJson)
    : null;

  // Stale-report detection. Once we let candidates edit the
  // transcript from `complete` (via the new edit-and-re-analyze
  // surface), the report can fall out of sync with the live text:
  // the user may auto-save edits and navigate away without
  // re-analyzing. We compare `transcript.updatedAt` against the
  // report's `createdAt` and surface a banner so the user knows
  // what they're looking at no longer matches the call text.
  // The 5-second cushion absorbs clock skew between the worker
  // (which writes the report) and the transcript-edit endpoint —
  // a freshly-completed analysis should not flash a stale banner.
  const reportIsStale =
    row.state === "complete" &&
    transcript !== null &&
    reportRow != null &&
    transcript.updatedAt.getTime() - reportRow.createdAt.getTime() > 5_000;

  // Fallback-report detection. When the LLM fails (validation
  // error, transient unavailability, or the onFailure rescue path
  // in `analyze-session.ts`), the worker persists a STUB report
  // via `buildFallbackReport(...)` and the session lands in
  // `complete` — not `failed`. Without this banner the user sees
  // the stub copy (which tells them to retry) but no button
  // anywhere to act on it: the `FailedPanel`'s `RetryButton` only
  // renders in `failed` state, and the dashboard doesn't carry
  // per-session controls. The `modelVersion` carries a
  // `fallback:<reason>` sentinel set in `buildFallbackReport` so
  // we can detect this server-side.
  //
  // The `thin_transcript` reason is excluded: that path's user-
  // facing copy points at re-recording or editing the transcript
  // (the analyzer would just produce the same stub on a same-input
  // retry), so surfacing a Retry button would route the candidate
  // to a dead end.
  const fallbackReason =
    row.state === "complete" &&
    reportRow?.modelVersion?.startsWith(FALLBACK_MODEL_VERSION_PREFIX)
      ? reportRow.modelVersion.slice(FALLBACK_MODEL_VERSION_PREFIX.length)
      : null;
  const showFallbackRetryBanner =
    fallbackReason !== null && fallbackReason !== "thin_transcript";

  const outcomeForCard: OutcomeCardData | null = outcomeRow
    ? {
        outcomeType: outcomeRow.outcomeType as OutcomeType,
        outcomeReceivedAt: outcomeRow.outcomeReceivedAt,
        recordedAt: outcomeRow.recordedAt,
        nextRoundType: outcomeRow.nextRoundType,
        feedbackReceived: outcomeRow.feedbackReceived,
        reflectionNotes: outcomeRow.reflectionNotes,
        wouldChange: outcomeRow.wouldChange,
        sessionCreatedAt: row.createdAt,
      }
    : null;

  // `transcripts.word_count` is pinned to the original STT-
  // derived count and never recomputed when the candidate edits the
  // transcript via the edit-and-re-analyze flow. Reading it
  // verbatim makes the speech-pace gauge AND the SESSION sidebar
  // drift the moment any edit lands ("5 wpm" for a 5-minute
  // interview that was edited to expand the verbatim text). Compute
  // the effective count once so both surfaces stay in lockstep with
  // each other and with the analyze pipeline's `effectiveWordCount`
  // precedent in `lib/llm/client.ts`.
  const transcriptWordCount = transcript
    ? effectiveWordCount({
        wordCount: transcript.wordCount,
        editedText: transcript.editedText,
      })
    : 0;

  return (
    <section className="mx-auto max-w-6xl px-6 py-12">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground print:hidden"
        data-print-hide
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to dashboard
      </Link>

      <header className="mt-6">
        {/*
          Header layout (per the visual-refinement spec):
            - Company name in title case (NOT small-caps) at 16px /
              weight 500 — sits above the role title as supporting
              context, not as a kicker label.
            - Role title at 24px / weight 500 — large enough to be
              the page headline but lighter than the previous 30px
              semibold so it reads as quieter authority than the
              old shout.
            - Meta line at 13px muted with just level + round —
              the creation date moved to the sidebar's SESSION
              block to match the "Generated {date}" sibling.
            - State badge stays anchored top-right of the title row.
        */}
        <div
          className="flex items-center gap-2 font-medium text-foreground"
          style={{ fontSize: "16px" }}
        >
          <CompanyLogo name={row.companyName} className="size-4" />
          <span>{row.companyName}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
          <h1
            className="font-medium tracking-tight"
            style={{ fontSize: "24px" }}
          >
            {row.roleTitle}
          </h1>
          <span
            className={`rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium ${
              row.state === "complete"
                ? "text-emerald-700"
                : row.state === "analyzing"
                  ? "text-muted-foreground"
                  : row.state === "failed"
                    ? "text-rose-700"
                    : "text-muted-foreground"
            }`}
          >
            {row.state}
          </span>
        </div>
        <p
          className="mt-1 text-muted-foreground"
          style={{ fontSize: "13px" }}
        >
          {capitalize(row.level)} · {labelForRound(row.roundType)} round
        </p>
      </header>

      {/* Compact outcome indicator — only shows when an outcome has
          been recorded. The EmptyOutcomeCard in <main> below handles
          the "not recorded yet" state. */}
      {row.state === "complete" && (
        <OutcomeRow sessionId={id} outcome={outcomeForCard} />
      )}

      <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_280px]">
        <main data-print-content>
          {reportIsStale && <StaleReportBanner sessionId={id} />}
          {showFallbackRetryBanner && (
            <FallbackRetryBanner sessionId={id} />
          )}
          {row.state === "analyzing" ? (
            <AnalyzingPanel />
          ) : row.state === "failed" ? (
            <FailedPanel sessionId={id} />
          ) : reportRow == null ? (
            <NoReportPanel />
          ) : parsedReport && parsedReport.success ? (
            <ReportView
              report={parsedReport.data}
              roundType={row.roundType}
              sessionId={id}
              transcript={
                transcript
                  ? {
                      wordCount: transcriptWordCount,
                      durationSeconds: transcript.durationSeconds,
                    }
                  : null
              }
              reportCreatedAt={reportRow.createdAt}
            />
          ) : (
            <LegacyReportPanel raw={reportRow.reportJson} />
          )}
        </main>

        <aside
          data-print-hide
          className="space-y-6 lg:sticky lg:top-6 lg:self-start print:hidden"
        >
          <div className="rounded-xl border border-border bg-background p-5">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Session
            </h2>
            <dl className="mt-3 space-y-2 text-sm">
              {transcript && (
                <>
                  <DT
                    icon={<Clock className="size-3.5" aria-hidden />}
                    label="Duration"
                    value={formatDuration(transcript.durationSeconds)}
                  />
                  <DT
                    icon={<FileText className="size-3.5" aria-hidden />}
                    label="Words"
                    value={transcriptWordCount.toLocaleString()}
                  />
                </>
              )}
              <DT
                icon={<Layers className="size-3.5" aria-hidden />}
                label="Artifacts"
                value={String(artifacts.length)}
              />
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
                  Created
                </dt>
                <dd className="whitespace-nowrap text-sm font-medium tabular-nums">
                  <LocalTime
                    date={row.createdAt}
                    options={{ year: "numeric", month: "short", day: "numeric" }}
                  />
                </dd>
              </div>
              {reportRow && (
                <div className="flex items-center justify-between gap-2">
                  <dt className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
                    Generated
                  </dt>
                  <dd className="whitespace-nowrap text-sm font-medium tabular-nums">
                    <LocalTime date={reportRow.createdAt} />
                  </dd>
                </div>
              )}
              {row.state === "complete" && (
                <OutcomeDT
                  sessionId={id}
                  outcomeType={
                    outcomeForCard
                      ? (outcomeForCard.outcomeType as OutcomeDisplayType)
                      : null
                  }
                />
              )}
            </dl>
          </div>

          {transcript && (
            <div className="rounded-xl border border-border bg-background p-5">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Source
              </h2>
              {/*
                "View transcript" stays as a text link — it's a
                read affordance, not an action. The two write
                affordances below ("Add artifacts" / "Edit text
                & re-analyze") promote to outline buttons so
                they read as proper actions rather than tertiary
                links the candidate might miss. The visual-
                refinement spec calls this out specifically: the
                edit + add paths are the candidate's two main
                tools for iterating on the report and shouldn't
                hide behind plain underlines.
              */}
              <ul className="mt-3 space-y-1.5 text-sm">
                <li>
                  <Link
                    href={`/sessions/${id}/review`}
                    className="text-foreground hover:underline"
                  >
                    View transcript →
                  </Link>
                </li>
              </ul>
              <div className="mt-3 flex flex-col gap-2">
                <Button
                  asChild
                  size="sm"
                  variant="outline"
                  className="w-full justify-start"
                >
                  <Link href={`/sessions/${id}/augment`}>
                    Add artifacts ({artifacts.length})
                  </Link>
                </Button>
                {row.state === "complete" && (
                  <Button
                    asChild
                    size="sm"
                    variant="outline"
                    className="w-full justify-start"
                  >
                    <Link href={`/sessions/${id}/edit`}>
                      Edit text &amp; re-analyze
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          )}

          {previousReports.length > 0 && (
            <div className="rounded-xl border border-border bg-background p-5">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Previous analyses
              </h2>
              <p className="mt-2 text-xs text-muted-foreground">
                Every re-analysis is preserved — click any entry to view
                that earlier report.
              </p>
              <ul className="mt-3 space-y-1.5 text-sm">
                {previousReports.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/sessions/${id}/reports/${r.id}`}
                      className="text-muted-foreground hover:text-foreground hover:underline"
                    >
                      View analysis from{" "}
                      <LocalTime date={r.createdAt} />{" "}→
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {row.state === "complete" && (
            <div className="rounded-xl border border-border bg-background p-5">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Actions
              </h2>
              <div className="mt-3">
                <SessionActions sessionId={id} />
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function AnalyzingPanel() {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-12 text-center">
      {/*
        Client island that drives `router.refresh()` on a 4s
        cadence while this panel is mounted. The server re-renders
        with the new state when the worker finishes, swapping this
        panel for the report (or the failed panel) without a
        manual reload.
      */}
      <AnalyzingPoller />
      <Loader2
        className="mx-auto size-6 animate-spin text-muted-foreground"
        aria-hidden
      />
      <h2 className="mt-4 text-lg font-semibold">
        We&apos;re analyzing your interview
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        This takes about 1-2 minutes. Feel free to leave this page —
        we&apos;ll email you the moment it&apos;s ready, and your
        report will be waiting in your dashboard.
      </p>
      {/*
        Time-driven stepper that breaks the wait into four visible
        phases. See `analysis-stepper.tsx` for the rationale on why
        it's pseudo-progress rather than wired to real worker state.
      */}
      <AnalysisStepper />
    </div>
  );
}

function FailedPanel({ sessionId }: { sessionId: string }) {
  return (
    <div className="rounded-xl border border-rose-300/60 bg-rose-50/40 p-12 text-center">
      <h2 className="text-lg font-semibold">Analysis didn&apos;t complete</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Something went wrong on our end. Retry analysis with the same
        transcript and artifacts — no need to re-record.
      </p>
      <div className="mt-6 inline-flex flex-col items-center gap-2">
        <RetryButton sessionId={sessionId} />
      </div>
    </div>
  );
}

function NoReportPanel() {
  return (
    <div className="rounded-xl border border-border bg-background p-12 text-center">
      <h2 className="text-lg font-semibold">No report yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        We don&apos;t have a feedback report for this session yet.
      </p>
    </div>
  );
}

function StaleReportBanner({ sessionId }: { sessionId: string }) {
  return (
    <div
      role="status"
      data-print-hide
      className="mb-6 flex items-start gap-3 rounded-lg border border-amber-300/60 bg-amber-50/60 p-4 text-sm text-amber-900 print:hidden"
    >
      <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium">
          The transcript was edited after this report was generated.
        </p>
        <p>
          The feedback below still reflects the previous text.{" "}
          <Link
            href={`/sessions/${sessionId}/edit`}
            className="font-medium underline underline-offset-2"
          >
            Re-analyze with the updated text →
          </Link>
        </p>
      </div>
    </div>
  );
}

/**
 * Surfaces the `RetryButton` above a stub fallback report.
 *
 * The worker writes a `buildFallbackReport(...)` row when the LLM
 * fails (validation, unavailable, onFailure rescue) and moves the
 * session to `complete` so the user lands on a real report page
 * instead of the bare failed-panel. The
 * stub's copy tells the user to retry — this banner is what makes
 * that instruction actionable. Rose-tinted to match the
 * `FailedPanel` aesthetic so the candidate reads it as "the same
 * recoverable failure category, just rendered alongside a stub
 * instead of replacing the report entirely".
 *
 * Hidden in the historical viewer (`/sessions/:id/reports/:reportId`)
 * — that surface is for navigating past report snapshots, and
 * retrying based on an old fallback would re-run the CURRENT
 * session, not the snapshot's underlying state.
 */
function FallbackRetryBanner({ sessionId }: { sessionId: string }) {
  return (
    <div
      role="status"
      data-print-hide
      className="mb-6 flex flex-col gap-3 rounded-lg border border-rose-300/60 bg-rose-50/60 p-4 text-sm text-rose-900 sm:flex-row sm:items-start sm:justify-between print:hidden dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-200"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium">
            We couldn&apos;t generate a full report this time.
          </p>
          <p>
            Retry to re-run analysis on the same transcript and
            artifacts — no need to re-record. Most retries succeed on the
            second attempt.
          </p>
        </div>
      </div>
      <RetryButton
        sessionId={sessionId}
        className="shrink-0 sm:self-center"
      />
    </div>
  );
}

function LegacyReportPanel({ raw }: { raw: unknown }) {
  return (
    <div className="rounded-xl border border-amber-300/60 bg-amber-50/30 p-6">
      <h2 className="text-lg font-semibold">Older report format</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This report was generated before the latest schema. Re-run analysis
        to get the new layout.
      </p>
      <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-background p-3 text-xs">
        {JSON.stringify(raw, null, 2)}
      </pre>
    </div>
  );
}

function DT({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode | null;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="whitespace-nowrap text-sm font-medium tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/**
 * Sidebar SESSION block row for the session outcome.
 * Shows a colored 8px dot + label + Edit/Add link.
 * The dot uses aria-hidden since the label carries the meaning.
 */
function OutcomeDT({
  sessionId,
  outcomeType,
}: {
  sessionId: string;
  outcomeType: OutcomeDisplayType | null;
}) {
  const display = outcomeType ? OUTCOME_DISPLAY[outcomeType] : null;
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
        Outcome
      </dt>
      <dd className="flex items-center gap-1.5 text-sm">
        {display ? (
          <>
            <span
              aria-hidden="true"
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ backgroundColor: display.dotColor }}
            />
            <span className="font-medium">{display.label}</span>
            <Link
              href={`/sessions/${sessionId}/outcome`}
              className="ml-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Edit
            </Link>
          </>
        ) : (
          <>
            <span
              aria-hidden="true"
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ backgroundColor: "var(--color-text-tertiary)" }}
            />
            <span className="text-muted-foreground">Not recorded</span>
            <Link
              href={`/sessions/${sessionId}/outcome`}
              className="ml-1 text-xs text-primary hover:underline"
            >
              Add
            </Link>
          </>
        )}
      </dd>
    </div>
  );
}

function labelForRound(t: string): string {
  switch (t) {
    case "coding":
      return "Coding";
    case "system_design":
      return "System design";
    case "behavioral":
      return "Behavioral";
    case "other":
      return "Other";
    default:
      return t;
  }
}

/**
 * Title-case the level enum for header display. The DB stores
 * lowercase ("senior" / "staff") because we use it as a routing
 * key elsewhere; this helper just capitalizes the first letter
 * for the human-facing meta line ("Senior · Behavioral round").
 */
function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
