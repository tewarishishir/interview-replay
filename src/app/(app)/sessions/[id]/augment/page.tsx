import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { ACTIVE_ARTIFACT_TYPES } from "@/lib/db/schema";
import { getSessionForReview } from "@/lib/queries/transcripts";
import { serializeArtifact } from "@/lib/sessions/artifact-serializer";
import { ARTIFACT_WRITE_ALLOWED_STATES } from "@/lib/sessions/artifacts";
import { SessionAugment } from "@/components/app/session-augment";

export const metadata: Metadata = {
  title: "Add context",
};

const paramsSchema = z.object({
  id: z.string().uuid(),
});

type PageProps = {
  params: Promise<{ id: string }>;
};

/**
 * Server-rendered shell for the "add context" screen.
 *
 * State guard: any of `review | analyzing | complete`. The candidate
 * may keep adding context after analysis kicks off (e.g., they
 * remembered a question while the LLM was thinking).
 */
export default async function AugmentSessionPage({ params }: PageProps) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { id } = parsed.data;

  const session = await auth();
  if (!session?.user?.id) {
    redirect(
      `/signin?callbackUrl=${encodeURIComponent(`/sessions/${id}/augment`)}`,
    );
  }

  const bundle = await getSessionForReview(id, session.user.id);
  if (!bundle) notFound();

  if (!ARTIFACT_WRITE_ALLOWED_STATES.includes(bundle.session.state)) {
    redirect(`/sessions/${id}`);
  }

  // Filter to active types only — legacy rows (pre-migration) just
  // wouldn't render an edit/delete control, but we don't want them
  // mixed into the new sectioned UI either. We DO include both
  // user-added and AI-inferred (confirmed, suggested, dismissed)
  // rows so the question section can render its three groupings.
  const activeArtifacts = bundle.artifacts.filter((a) =>
    (ACTIVE_ARTIFACT_TYPES as readonly string[]).includes(a.artifactType),
  );

  return (
    <SessionAugment
      session={{
        id: bundle.session.id,
        companyName: bundle.session.companyName,
        roleTitle: bundle.session.roleTitle,
        level: bundle.session.level,
        state: bundle.session.state,
        // Surfaced solely so the in-page DeleteSessionButton can
        // mirror the same fee logic the DELETE API uses (only
        // recordings > 15 min trigger the transcription fee).
        // Null is acceptable — the fee helper treats it as "we
        // don't know" and falls through to no charge.
        transcriptDurationSeconds: bundle.transcript?.durationSeconds ?? null,
      }}
      initialArtifacts={activeArtifacts.map(serializeArtifact)}
    />
  );
}
