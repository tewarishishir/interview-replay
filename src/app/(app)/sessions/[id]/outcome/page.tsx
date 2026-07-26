import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { getSession } from "@/lib/queries/sessions";
import { getOutcomeForSession } from "@/lib/sessions/outcomes";
import { CompanyLogo } from "@/components/app/company-logo";
import { OutcomeForm, type OutcomeFormInitial } from "@/components/app/outcome-form";
import { OutcomeReminderTracker } from "@/components/app/outcome-reminder-tracker";

export const metadata: Metadata = {
  title: "Record interview outcome",
};

const paramsSchema = z.object({
  id: z.string().uuid(),
});

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const REMINDER_UTM_CAMPAIGN = "outcome_reminder";

const ROUND_LABEL: Record<string, string> = {
  coding: "coding",
  system_design: "system design",
  behavioral: "behavioral",
  other: "interview",
};

/**
 * Dedicated page for recording / editing the outcome of a
 * completed interview. The PRD asks for a "modal/sheet" but the
 * codebase has no Dialog primitive and every other rich form flow
 * (`/review`, `/edit`, `/augment`) is a dedicated route — we match
 * that pattern here for consistency and to keep the report page's
 * client surface tiny.
 *
 * The page is a thin server component:
 *   1. Loads session ownership + state (must be `complete`).
 *   2. Loads any existing outcome (so the form starts pre-filled
 *      when the user clicks Edit on the report).
 *   3. Renders the client form.
 *
 * Mutations happen via the JSON API (POST/PATCH /api/sessions/:id/
 * outcome) — that's the same surface the reminder-email link will
 * eventually click into.
 */
export default async function OutcomePage({ params, searchParams }: PageProps) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { id } = parsed.data;

  // The reminder email's CTA carries `utm_campaign=outcome_reminder`.
  // We mount the click-tracker conditionally so the analytics
  // event only fires for traffic that actually came from the
  // email (vs. an in-app navigation from the report page).
  const sp = (await searchParams) ?? {};
  const cameFromReminder = sp.utm_campaign === REMINDER_UTM_CAMPAIGN;

  // `getActiveUserId` (NOT raw `auth()`) so a soft-deleted user
  // whose JWT cookie is still valid bounces here just like they
  // would on the report page or any of the API routes. The raw
  // `auth()` only validates the cookie signature and would let a
  // deleted user keep editing their old sessions until token
  // expiry.
  const userId = await getActiveUserId();
  if (!userId) {
    redirect("/signin");
  }

  const row = await getSession(id, userId);
  if (!row) notFound();

  // Outcomes only make sense for completed sessions. Bounce the
  // user back to the report view (which itself routes them to the
  // right earlier-state UI if needed). We do NOT 404 here — we
  // want them to land back on the report so they understand why
  // the outcome surface isn't available yet.
  if (row.state !== "complete") {
    redirect(`/sessions/${id}`);
  }

  const existing = await getOutcomeForSession(id);

  const roundLabel = ROUND_LABEL[row.roundType] ?? "interview";
  const heading = `Outcome for ${row.companyName} ${roundLabel} round`;

  return (
    <section className="mx-auto max-w-2xl px-6 py-12">
      {cameFromReminder && <OutcomeReminderTracker sessionId={id} />}
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
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {heading}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We use this only to track your progress over time and improve
          your coaching. It is never shared with the company you
          interviewed with, and it does not change anything in the
          existing report.
        </p>
      </header>

      <div className="mt-8">
        <OutcomeForm
          sessionId={id}
          initial={
            existing
              ? ({
                  outcomeType: existing.outcomeType as OutcomeFormInitial["outcomeType"],
                  outcomeReceivedAt: existing.outcomeReceivedAt
                    ? existing.outcomeReceivedAt.toISOString()
                    : "",
                  nextRoundType: existing.nextRoundType ?? "",
                  feedbackReceived: existing.feedbackReceived ?? "",
                  noFeedbackShared: existing.feedbackReceived === null && existing.feedbackReceived !== undefined
                    ? false
                    : false,
                  askedForFeedback: existing.askedForFeedback,
                  reflectionNotes: existing.reflectionNotes ?? "",
                  wouldChange: existing.wouldChange ?? "",
                } satisfies OutcomeFormInitial)
              : null
          }
        />
      </div>
    </section>
  );
}
