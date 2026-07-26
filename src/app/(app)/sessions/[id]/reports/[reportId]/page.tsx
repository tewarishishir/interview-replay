import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, History } from "lucide-react";
import { LocalTime } from "@/components/ui/local-time";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { reportSchema } from "@/lib/llm";
import { effectiveWordCount } from "@/lib/sessions/effective-transcript";
import { CompanyLogo } from "@/components/app/company-logo";
import { ReportView } from "@/components/app/report-view";

export const metadata: Metadata = {
  title: "Historical report",
};

/**
 * Read-only viewer for a specific (potentially earlier) `reports`
 * row. Re-analyses APPEND a new row rather than overwrite, so each
 * paid analysis run is preserved for the lifetime of the session.
 * The main session detail page (`/sessions/:id`) renders the latest
 * report; this page lets the user navigate back to a prior version
 * via the "View previous analysis" link in the sidebar.
 *
 * Hardening:
 *   - Ownership is checked via the join through `interview_sessions`,
 *     not by trusting the URL: the report row is loaded by both
 *     `id` AND `session_id`, and the session is loaded by both `id`
 *     AND `userId`. Either mismatch → 404. This prevents a user
 *     from peeking at someone else's analysis by URL-tampering.
 *   - If the request lands on the CURRENT report's id, we redirect
 *     to the canonical session page so the user doesn't see a stale
 *     "← Back to current" banner pointing at the same report. This
 *     also keeps the main page as the single surface where rebuild
 *     launchers render.
 */
const paramsSchema = z.object({
  id: z.string().uuid(),
  reportId: z.string().uuid(),
});

type PageProps = {
  params: Promise<{ id: string; reportId: string }>;
};

export default async function HistoricalReportPage({ params }: PageProps) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { id, reportId } = parsed.data;

  const session = await auth();
  if (!session?.user?.id) {
    redirect(
      `/signin?callbackUrl=${encodeURIComponent(
        `/sessions/${id}/reports/${reportId}`,
      )}`,
    );
  }

  // Ownership check: must be the user's session, and not soft-deleted.
  // We also pull `state` so the redirect-to-canonical decision below
  // can be state-aware: redirecting to /sessions/:id is the right
  // call when the canonical page would render the same report, but
  // it's a UX regression when the canonical page would render the
  // analyzing/failed panel instead (the user paid for the report
  // and is entitled to see it even while a re-analysis is mid-flight
  // or has failed).
  const [sessionRow] = await db
    .select({
      id: schema.interviewSessions.id,
      state: schema.interviewSessions.state,
      companyName: schema.interviewSessions.companyName,
      roleTitle: schema.interviewSessions.roleTitle,
      level: schema.interviewSessions.level,
      roundType: schema.interviewSessions.roundType,
      deletedAt: schema.interviewSessions.deletedAt,
    })
    .from(schema.interviewSessions)
    .where(
      and(
        eq(schema.interviewSessions.id, id),
        eq(schema.interviewSessions.userId, session.user.id),
      ),
    )
    .limit(1);
  if (!sessionRow || sessionRow.deletedAt) notFound();

  // Three reads against the session's indexed children:
  //   1. The specific report by (id, session_id). The session_id
  //      filter is the cross-session-tampering guard — `id` alone is
  //      enough to uniquely identify a row, but pinning `session_id`
  //      means a stolen reportId from a different session can never
  //      resolve here.
  //   2. The latest report id for this session, to decide whether to
  //      redirect to the canonical view.
  //   3. The transcript row for the session. We pull `wordCount`,
  //      `durationSeconds`, AND `editedText` — the gauge in the
  //      Communication section of `ReportView` grounds wpm on the
  //      effective transcript (edits override the original audio-
  //      derived count), so reading the stored `wordCount` verbatim
  //      would drift any time the candidate edited the transcript
  //      between analyses. See `effectiveWordCount` for the helper
  //      we run before passing the count down.
  //
  //      The wpm we display here therefore reflects the CURRENT
  //      transcript, not the transcript-at-the-time-of-this-
  //      analysis. We accept that drift over the alternative
  //      (storing a snapshot wpm on each report row) because the
  //      transcript-edit flow re-runs analyze and the user is
  //      expected to read the latest report afterwards; the
  //      historical viewer is a navigation convenience, not a
  //      forensic playback of every metric as it was.
  const [requested, latest, transcript] = await Promise.all([
    db
      .select({
        id: schema.reports.id,
        reportJson: schema.reports.reportJson,
        modelVersion: schema.reports.modelVersion,
        createdAt: schema.reports.createdAt,
      })
      .from(schema.reports)
      .where(
        and(
          eq(schema.reports.id, reportId),
          eq(schema.reports.sessionId, id),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: schema.reports.id,
        createdAt: schema.reports.createdAt,
      })
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, id))
      .orderBy(desc(schema.reports.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        wordCount: schema.transcripts.wordCount,
        durationSeconds: schema.transcripts.durationSeconds,
        editedText: schema.transcripts.editedText,
      })
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, id))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  if (!requested) notFound();

  // If the URL points at the current report AND the session is in
  // `complete`, redirect to the canonical detail page — that page
  // renders the same report with the full set of write-affordances
  // (rebuild launchers, edit-and-re-analyze, outcome card) anchored
  // on it, so duplicating those here is wasteful.
  //
  // We DO NOT redirect when the session is `analyzing` or `failed`:
  //   - `analyzing`: a new re-analysis is in flight. The canonical
  //     page would show the AnalyzingPanel and hide the prior
  //     report, but the user clicked through to the historical URL
  //     because they want to read the prior report (often to compare
  //     with what's being computed).
  //   - `failed`: the most-recent re-analysis failed. The canonical
  //     page shows the FailedPanel; the user paid for the report
  //     they're requesting and is entitled to read it.
  // Other states (`created`, `recording`, `transcribing`, `review`)
  // can't have `requested` set (no reports yet), so they 404'd above.
  if (
    sessionRow.state === "complete" &&
    latest &&
    latest.id === requested.id
  ) {
    redirect(`/sessions/${id}`);
  }

  const parsedReport = reportSchema.safeParse(requested.reportJson);

  return (
    <section className="mx-auto max-w-6xl px-6 py-12">
      <Link
        href={`/sessions/${id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to current analysis
      </Link>

      <header className="mt-6">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <CompanyLogo name={sessionRow.companyName} />
          <span>{sessionRow.companyName}</span>
        </div>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          {sessionRow.roleTitle}
        </h1>
      </header>

      <div
        role="status"
        className="mt-8 flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4 text-sm"
      >
        <History className="size-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium">
            You&apos;re viewing an earlier analysis from{" "}
            <LocalTime date={requested.createdAt} />
            .
          </p>
          <p className="text-muted-foreground">
            <Link
              href={`/sessions/${id}`}
              className="font-medium underline underline-offset-2"
            >
              Back to current analysis →
            </Link>
          </p>
        </div>
      </div>

      <div className="mt-8">
        {parsedReport.success ? (
          <ReportView
            report={parsedReport.data}
            roundType={sessionRow.roundType}
            sessionId={id}
            isHistorical
            transcript={
              transcript
                ? {
                    wordCount: effectiveWordCount({
                      wordCount: transcript.wordCount,
                      editedText: transcript.editedText,
                    }),
                    durationSeconds: transcript.durationSeconds,
                  }
                : null
            }
            reportCreatedAt={requested.createdAt}
          />
        ) : (
          <LegacyReportPanel raw={requested.reportJson} />
        )}
      </div>
    </section>
  );
}

function LegacyReportPanel({ raw }: { raw: unknown }) {
  return (
    <div className="rounded-xl border border-amber-300/60 bg-amber-50/30 p-6">
      <h2 className="text-lg font-semibold">Older report format</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This report was generated before the latest schema and we
        can&apos;t render it in the new layout. The raw stored output
        is included below for reference.
      </p>
      <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-background p-3 text-xs">
        {JSON.stringify(raw, null, 2)}
      </pre>
    </div>
  );
}
