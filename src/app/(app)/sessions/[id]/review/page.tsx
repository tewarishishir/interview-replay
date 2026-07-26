import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { getSessionForReview } from "@/lib/queries/transcripts";
import { serializeArtifact } from "@/lib/sessions/artifact-serializer";
import { TranscriptReview } from "@/components/app/transcript-review";

export const metadata: Metadata = {
  title: "Review transcript",
};

const paramsSchema = z.object({
  id: z.string().uuid(),
});

type PageProps = {
  params: Promise<{ id: string }>;
};

/**
 * Server-rendered shell for the transcript-review screen.
 *
 * Three jobs:
 *   1. Validate the URL param.
 *   2. Re-check auth + ownership at the page boundary.
 *   3. State guard. The review page is only valid from `review`.
 *      Other states get bounced to the appropriate place — anything
 *      "before" review goes to the session detail page (which knows
 *      how to surface transcribing/uploading); anything "after"
 *      review (analyzing, complete) goes back to the detail page
 *      (transcript is locked once feedback generation starts).
 *   4. Hand the bundle to a Client Component that owns the textarea
 *      + auto-save + nav to /augment.
 */
export default async function ReviewSessionPage({ params }: PageProps) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { id } = parsed.data;

  const session = await auth();
  if (!session?.user?.id) {
    redirect(
      `/signin?callbackUrl=${encodeURIComponent(`/sessions/${id}/review`)}`,
    );
  }

  const bundle = await getSessionForReview(id, session.user.id);
  if (!bundle) notFound();

  if (bundle.session.state !== "review") {
    redirect(`/sessions/${id}`);
  }

  // Surface every AI-inferred suggestion to the candidate (high,
  // medium, AND low) — each card displays its confidence band so
  // the candidate can quickly judge before confirming or
  // dismissing. We only filter out rows the candidate has already
  // dismissed; confirmed rows stay visible (with a "Confirmed"
  // pill) so the candidate can see what they've acted on this
  // session.
  //
  // Historical version of this page only showed `high` rows on
  // the theory that medium/low risked phantom-memory contamination
  // ("oh yeah, the interviewer DID ask that, didn't they?"). The
  // product call now is the opposite: hiding suggestions also
  // hides useful ones, and the candidate is better equipped than
  // we are to filter — they were actually in the room. We mitigate
  // contamination risk via the explicit confidence label and the
  // "Wasn't asked" dismiss button.
  const aiInferredCards = bundle.artifacts
    .filter((a) => a.source === "ai_inferred" && a.dismissedAt === null)
    .map(serializeArtifact);

  return (
    <TranscriptReview
      session={{
        id: bundle.session.id,
        companyName: bundle.session.companyName,
        roleTitle: bundle.session.roleTitle,
        level: bundle.session.level,
      }}
      transcript={
        bundle.transcript
          ? {
              id: bundle.transcript.id,
              redactedText: bundle.transcript.redactedText,
              editedText: bundle.transcript.editedText,
              redactionCount: bundle.transcript.redactionCount,
              transcriptionError: bundle.transcript.transcriptionError,
              wordCount: bundle.transcript.wordCount,
              fillerWordCount: bundle.transcript.fillerWordCount,
              durationSeconds: bundle.transcript.durationSeconds,
            }
          : null
      }
      inferredQuestions={aiInferredCards}
    />
  );
}
