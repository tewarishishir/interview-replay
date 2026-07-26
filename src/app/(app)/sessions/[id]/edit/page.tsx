import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { MAX_BILLABLE_SECONDS } from "@/lib/credits";
import { getSessionForReview } from "@/lib/queries/transcripts";
import { CompanyLogo } from "@/components/app/company-logo";
import { TranscriptEdit } from "@/components/app/transcript-edit";

export const metadata: Metadata = {
  title: "Edit transcript",
};

const paramsSchema = z.object({
  id: z.string().uuid(),
});

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function EditSessionPage({ params }: PageProps) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { id } = parsed.data;

  const session = await auth();
  if (!session?.user?.id) {
    redirect(
      `/signin?callbackUrl=${encodeURIComponent(`/sessions/${id}/edit`)}`,
    );
  }

  const bundle = await getSessionForReview(id, session.user.id);

  if (!bundle) notFound();
  const { session: row, transcript } = bundle;

  if (row.state !== "complete") {
    redirect(`/sessions/${id}`);
  }

  if (!transcript || transcript.transcriptionError) {
    redirect(`/sessions/${id}`);
  }

  const durationSeconds = transcript.durationSeconds;
  const overLimit = durationSeconds > MAX_BILLABLE_SECONDS;

  return (
    <section className="mx-auto max-w-4xl px-6 py-10">
      <Link
        href={`/sessions/${id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to report
      </Link>

      <header className="mt-6">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <CompanyLogo name={row.companyName} />
          <span>{row.companyName}</span>
        </div>
        <h1 className="mt-1.5 text-3xl font-semibold tracking-tight">
          Edit call text
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Read through your interview transcript and clean up anything the
          model got wrong. When you&apos;re ready, re-analyze to regenerate
          the report based on the updated text.
        </p>
      </header>

      <TranscriptEdit
        sessionId={id}
        transcript={{
          id: transcript.id,
          editedText: transcript.editedText,
          redactedText: transcript.redactedText,
          durationSeconds: transcript.durationSeconds,
          wordCount: transcript.wordCount,
        }}
        overLimit={overLimit}
      />
    </section>
  );
}
