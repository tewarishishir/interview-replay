import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Clock, FileText, Layers } from "lucide-react";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { getSessionForReview } from "@/lib/queries/transcripts";

const MAX_RECORDING_SECONDS = 7200;
import { eq, desc } from "drizzle-orm";
import { db, schema } from "@/lib/db";
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

  const [bundle, lastReportRow] = await Promise.all([
    getSessionForReview(id, session.user.id),
    db
      .select({ createdAt: schema.reports.createdAt })
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, id))
      .orderBy(desc(schema.reports.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  const isReanalysis = lastReportRow !== null;

  if (!bundle) notFound();
  const { session: row, transcript, artifacts } = bundle;

  const allowed = ["review", "analyzing", "complete"] as const;
  if (!allowed.includes(row.state as (typeof allowed)[number])) {
    redirect(`/sessions/${id}`);
  }

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
  const overLimit = durationSeconds > MAX_RECORDING_SECONDS;

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
          isReanalysis={isReanalysis}
        />
        <p className="text-xs text-muted-foreground">
          Your transcript and audio stay on your local machine and are never deleted.
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
