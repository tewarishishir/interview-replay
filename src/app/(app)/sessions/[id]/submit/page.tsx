import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Clock, FileText, Layers, Wallet } from "lucide-react";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  creditsForDuration,
  freeReanalysisAvailable,
  hasConsumedFreeReanalysis,
  MAX_BILLABLE_SECONDS,
  REANALYSIS_FIXED_CREDIT_COST,
} from "@/lib/credits";
import { db, schema } from "@/lib/db";
import { getDashboardUser } from "@/lib/queries/sessions";
import { getSessionForReview } from "@/lib/queries/transcripts";
import { eq, desc } from "drizzle-orm";
import { AnalyzeButton } from "@/components/app/analyze-button";
import { CompanyLogo } from "@/components/app/company-logo";

export const metadata: Metadata = {
  title: "Submit for analysis",
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

export default async function SubmitSessionPage({ params }: PageProps) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { id } = parsed.data;

  const session = await auth();
  if (!session?.user?.id) {
    redirect(
      `/signin?callbackUrl=${encodeURIComponent(`/sessions/${id}/submit`)}`,
    );
  }

  const [bundle, dashboardUser, lastReportRow] = await Promise.all([
    getSessionForReview(id, session.user.id),
    getDashboardUser(session.user.id),
    db
      .select({ createdAt: schema.reports.createdAt })
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, id))
      .orderBy(desc(schema.reports.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  // Free-re-run eligibility = within 24h AND the session's single
  // free slot hasn't been burned. The /edit page already composes
  // both gates; mirror it here so navigating back through /augment
  // → /submit can't re-offer a free run that /edit (correctly)
  // disables. The ledger lookup is deferred until we know there's
  // a prior report — first analyses are always paid, so the
  // count(*) queries inside `hasConsumedFreeReanalysis` would be
  // wasted work on the first-analysis path.
  const isReanalysis = lastReportRow !== null;
  const freeAlreadyUsed = isReanalysis
    ? await hasConsumedFreeReanalysis({
        sessionId: id,
        userId: session.user.id,
      })
    : false;

  if (!bundle || !dashboardUser) notFound();
  const { session: row, transcript, artifacts } = bundle;

  // States that can land on the submit step. Anything earlier in
  // the lifecycle goes back to the session detail page (which
  // shows recording / transcribing UI).
  const allowed = ["review", "analyzing", "complete"] as const;
  if (!allowed.includes(row.state as (typeof allowed)[number])) {
    redirect(`/sessions/${id}`);
  }

  // If we don't have a transcript yet, kick the user back to
  // the session page where they'll see the transcribing state.
  if (!transcript) {
    redirect(`/sessions/${id}`);
  }

  if (transcript.transcriptionError) {
    return (
      <section className="mx-auto max-w-2xl px-6 py-16">
        <Link
          href={`/sessions/${id}/augment`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to add context
        </Link>

        <div className="mt-8 rounded-xl border border-border bg-muted/30 p-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Analysis isn&apos;t available
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Transcription failed for this session, so there&apos;s no usable
            text to analyze. You can start a new session and re-record.
          </p>
        </div>
      </section>
    );
  }

  const durationSeconds = transcript.durationSeconds;
  const overLimit = durationSeconds > MAX_BILLABLE_SECONDS;

  // Pricing diverges by whether this is a first analysis or a
  // re-analysis. First analysis is priced by duration (the
  // standard bucket ladder) because the transcription + LLM
  // round-trip is paid in full from this click. Re-analysis is a
  // flat `REANALYSIS_FIXED_CREDIT_COST` because we only need to
  // cover the LLM re-call — the transcript already exists.
  // The same calculation runs on the API route; this is the UI
  // preview and they MUST agree, which is why both call sites
  // import from `lib/credits/pricing.ts`.
  const baseCredits = (() => {
    if (overLimit || durationSeconds <= 0) return null;
    if (isReanalysis) return REANALYSIS_FIXED_CREDIT_COST;
    try {
      return creditsForDuration(durationSeconds);
    } catch {
      return null;
    }
  })();

  const free = freeReanalysisAvailable({
    lastReportAt: lastReportRow?.createdAt ?? null,
    freeReanalysisAlreadyUsed: freeAlreadyUsed,
  });
  const creditsRequired = free ? 0 : (baseCredits ?? 0);
  const canAfford =
    baseCredits !== null && dashboardUser.creditBalance >= creditsRequired;

  return (
    <section className="mx-auto max-w-2xl px-6 py-12">
      <Link
        href={`/sessions/${id}/augment`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to add context
      </Link>

      <div className="mt-6">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <CompanyLogo name={row.companyName} />
          <span>{row.companyName}</span>
        </div>
        <h1 className="mt-1.5 text-3xl font-semibold tracking-tight">
          Ready for analysis
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Review what we&apos;ll analyze, then submit when you&apos;re ready.
        </p>
      </div>

      {/*
        We deliberately don't surface the underlying model name to
        the candidate — they're paying for an analysis outcome, not
        an LLM SKU, and naming the provider invites both confusion
        ("is model X better than model Y?") and lock-in ("the report I
        got last week was on a different model"). The model version
        IS still recorded on the report row so we can reproduce a
        run if a customer disputes a score.
      */}
      <dl className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat
          icon={<Clock className="size-4" aria-hidden />}
          label="Duration"
          value={formatDuration(durationSeconds)}
        />
        <Stat
          icon={<FileText className="size-4" aria-hidden />}
          label="Words"
          value={transcript.wordCount.toLocaleString()}
        />
        <Stat
          icon={<Layers className="size-4" aria-hidden />}
          label="Artifacts"
          value={String(artifacts.length)}
        />
      </dl>

      <div className="mt-10 rounded-xl border border-border bg-muted/30 p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Cost
            </div>
            <div className="mt-1 text-2xl font-semibold tracking-tight">
              {free ? (
                <span>
                  <span className="line-through text-muted-foreground">
                    {baseCredits ?? "—"}
                  </span>{" "}
                  0 credits
                </span>
              ) : baseCredits === null ? (
                <span className="text-base font-normal text-muted-foreground">
                  unavailable
                </span>
              ) : (
                <span>
                  {baseCredits} credit{baseCredits === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {free ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Re-analysis within 24 hours of the previous report — on us.
                After this run, each re-analysis costs 1 credit.
              </p>
            ) : isReanalysis ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Re-analyzing an existing session costs a flat 1 credit.
              </p>
            ) : null}
          </div>
          <div className="text-right">
            <div className="flex items-center justify-end gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Wallet className="size-3.5" aria-hidden />
              Your balance
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {dashboardUser.creditBalance} credit
              {dashboardUser.creditBalance === 1 ? "" : "s"}
            </div>
          </div>
        </div>
      </div>

      {overLimit && (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-amber-300/60 bg-amber-50/60 p-4 text-sm text-amber-900"
        >
          This recording is longer than 120 minutes. Analysis tops out at the
          120-minute bucket — please trim or split the recording before
          submitting.
        </div>
      )}

      <div className="mt-10 flex flex-col items-center gap-3">
        <AnalyzeButton
          sessionId={id}
          creditsRequired={creditsRequired}
          canAfford={canAfford && !overLimit}
          isReanalysis={isReanalysis}
        />
        {!overLimit && !canAfford && (
          <p className="text-sm text-muted-foreground">
            You need {creditsRequired - dashboardUser.creditBalance} more
            credit
            {creditsRequired - dashboardUser.creditBalance === 1 ? "" : "s"}{" "}
            to start analysis.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Your transcript stays redacted. Audio is deleted ~60 seconds after
          transcription.
        </p>
      </div>
    </section>
  );
}

interface StatProps {
  icon: React.ReactNode;
  label: string;
  value: string;
}
function Stat({ icon, label, value }: StatProps) {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="mt-2 text-base font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
