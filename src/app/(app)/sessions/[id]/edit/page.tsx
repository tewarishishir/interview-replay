import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  freeReanalysisAvailable,
  hasConsumedFreeReanalysis,
  MAX_BILLABLE_SECONDS,
  REANALYSIS_FIXED_CREDIT_COST,
} from "@/lib/credits";
import { db, schema } from "@/lib/db";
import { getDashboardUser } from "@/lib/queries/sessions";
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

/**
 * Post-analysis transcript edit + re-analyze surface.
 *
 * Reachable via "Edit text & re-analyze" in the report-page sidebar
 * once a session is `complete`. Other states bounce back to the
 * detail page (which knows how to surface them):
 *
 *   - `review`     → user hasn't analyzed yet, send them through
 *                    the proper /review → /augment → /submit flow.
 *   - `analyzing`  → transcript is locked, detail page shows the
 *                    "we're analyzing" panel.
 *   - `failed`     → detail page surfaces the reset-and-retry CTA.
 *   - earlier      → nothing to edit yet.
 *
 * The page renders a textarea plus a single "Re-analyze (X credits)"
 * action. The client island handles auto-save and the analyze POST;
 * the server's job is just to gather the bundle and compute the
 * up-front price honestly.
 */
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

  // Defer the ledger lookup until we know there's a prior report
  // — first analyses can never be free, so the answer is fixed.
  // Saves two count(*) queries when the page is somehow reached
  // for a session with no reports (the state guard below would
  // bounce that case, but the deferral is still correct semantics
  // and keeps the helper call narrowly conditional on its input
  // being meaningful).
  const freeAlreadyUsed = lastReportRow
    ? await hasConsumedFreeReanalysis({
        sessionId: id,
        userId: session.user.id,
      })
    : false;

  if (!bundle || !dashboardUser) notFound();
  const { session: row, transcript } = bundle;

  // Only `complete` is editable here. Everything else has a more
  // appropriate UI elsewhere — bounce back to the detail page,
  // which fans out to the right sub-screen.
  if (row.state !== "complete") {
    redirect(`/sessions/${id}`);
  }

  if (!transcript || transcript.transcriptionError) {
    redirect(`/sessions/${id}`);
  }

  const durationSeconds = transcript.durationSeconds;
  const overLimit = durationSeconds > MAX_BILLABLE_SECONDS;

  // Two prices coexist on this page:
  //   - `baseCredits` is what re-analysis would cost outside the
  //     free 24h window (and what we surface on the button so the
  //     user is never surprised by a charge they didn't expect).
  //   - `discountedCredits` is what the API will actually consume
  //     on this click — 0 when the free re-run is available, else
  //     equal to `baseCredits`. We pass both to the client so it
  //     can show the discount when it applies.
  //
  // Re-analysis is priced at a FLAT `REANALYSIS_FIXED_CREDIT_COST`
  // (currently 1 credit), not the duration-based first-analysis
  // price. Rationale lives in `lib/credits/pricing.ts`: the
  // transcription cost is already sunk for the original session, so
  // re-running only needs to cover the LLM re-call. We still
  // honor the `overLimit` check (no re-analysis above the 120-min
  // cap) because the LLM still has to read the transcript and the
  // truncation marker would degrade the report quality.
  //
  // Free eligibility = within the 24h window AND the session
  // hasn't already burned its single free re-run. After the first
  // re-analysis lands (delta=0 ledger row), this renders false and
  // the button reverts to the paid 1-credit price — that's the
  // load-bearing protection against unbounded free LLM rolls.
  const baseCredits =
    overLimit || durationSeconds <= 0 ? null : REANALYSIS_FIXED_CREDIT_COST;
  const free = freeReanalysisAvailable({
    lastReportAt: lastReportRow?.createdAt ?? null,
    freeReanalysisAlreadyUsed: freeAlreadyUsed,
  });
  const discountedCredits = free ? 0 : (baseCredits ?? 0);
  const canAfford =
    baseCredits !== null && dashboardUser.creditBalance >= discountedCredits;

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
          the report based on the updated text.{" "}
          <strong className="font-medium text-foreground">
            Re-analyzing charges credits
          </strong>{" "}
          — see the cost on the button below.
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
        baseCredits={baseCredits}
        discountedCredits={discountedCredits}
        free={free}
        canAfford={canAfford}
        creditBalance={dashboardUser.creditBalance}
        overLimit={overLimit}
      />
    </section>
  );
}
