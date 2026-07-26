import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { getSession } from "@/lib/queries/sessions";
import { SessionRecorder } from "@/components/app/session-recorder";

export const metadata: Metadata = {
  title: "Record session",
};

const paramsSchema = z.object({
  id: z.string().uuid(),
});

type PageProps = {
  params: Promise<{ id: string }>;
};

/**
 * Server-rendered shell for the recorder. Three jobs:
 *
 *   1. Validate the URL param.
 *   2. Re-check auth + ownership at the page boundary (the (app)
 *      layout already redirected unauthenticated users; we still
 *      gate here so a server-component re-render or a missing
 *      cookie can't slip through).
 *   3. Hand the metadata down to a Client Component that owns the
 *      whole recording lifecycle.
 *
 * The recorder UI itself MUST be a Client Component (audio capture is
 * a browser-only API), but the metadata that drives its header is
 * server-fetched here so the layout doesn't flash an empty card on
 * first paint.
 *
 * State-aware redirects:
 *   - The recorder is only valid from `created`. Any other state means
 *     either a stale tab (recording/uploading/transcribing on another
 *     device, or the user reloaded mid-flight) or a finished session
 *     (review/analyzing/complete) or a terminal state
 *     (deleted/failed/expired). All of these get bounced — letting
 *     the recorder mount in those cases would either step on an
 *     in-progress upload, produce a duplicate audio_files row, or
 *     show a "Start recording" CTA that immediately 409s the user.
 *   - `recording` specifically: a refresh of an active recording loses
 *     the in-memory Blob (browsers can't survive that). The right UX
 *     is to send the user back to the dashboard with a clear "this
 *     session is stuck mid-recording" indicator; for now we route to
 *     the session detail page which surfaces the same context.
 */
export default async function RecordSessionPage({ params }: PageProps) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { id } = parsed.data;

  const session = await auth();
  if (!session?.user?.id) {
    redirect(
      `/signin?callbackUrl=${encodeURIComponent(`/sessions/${id}/record`)}`,
    );
  }

  const row = await getSession(id, session.user.id);
  if (!row) notFound();

  // The recorder UI is only valid for `created` sessions. Anything
  // else gets redirected. We bounce to the session detail page,
  // which is the safe default landing for every non-`created` state
  // (it surfaces the appropriate next action — review, retry,
  // resurrect, etc. — based on the row's state).
  if (row.state !== "created") {
    redirect(`/sessions/${id}`);
  }

  return (
    <SessionRecorder
      session={{
        id: row.id,
        companyName: row.companyName,
        roleTitle: row.roleTitle,
        level: row.level,
        roundType: row.roundType,
      }}
    />
  );
}
