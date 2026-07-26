import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { toRebuildDto } from "@/lib/rebuilds/dto";
import { getRebuild, listRebuildsForSession } from "@/lib/rebuilds/queries";
import { loadRebuildProfileContext } from "@/lib/rebuilds/profile-context";
import { toProjectDto, toStoryDto } from "@/lib/profiles/dto";
import {
  RebuildFlow,
  type SourceImprovementContext,
} from "@/components/app/rebuild-flow";
import type { Report } from "@/lib/llm/schema";
import type { RebuildQuestionTheme } from "@/lib/db/schema";

export const metadata: Metadata = {
  title: "Practice rebuild",
};

const paramsSchema = z.object({ id: z.string().uuid() });

type PageProps = {
  params: Promise<{ id: string }>;
};

/**
 * Server-rendered shell for the 6-step Practice Rebuild flow.
 *
 * Responsibilities the page owns (vs. the client component):
 *
 *   1. Auth + ownership. `getRebuild(id, userId)` returns null
 *      both for "not found" and "not yours"; we 404 in either
 *      case so the API edge can't be probed via the URL.
 *
 *   2. Bundle the slabs the client needs in one round-trip:
 *
 *        - rebuild row (decrypted via the DTO)
 *        - profile context (matching stories + projects), filtered
 *          server-side by the rebuild's theme so a candidate with
 *          60 stories doesn't ship 59 irrelevant ones to the
 *          browser
 *        - source-session banner data when source_session_id is set
 *
 *   3. Resolve the "improvement summary" string the banner shows.
 *      The rebuild row stores `source_improvement_index` as a
 *      number; we look up the matching `report.improvements[i]` and
 *      surface its `action` (the "Try this next time" copy) plus
 *      the company + round label. The banner is best-effort: a
 *      missing report or an out-of-range index just hides it.
 *
 *   4. Skip Step 6 redirect. If the user navigates back to a rebuild
 *      that's already been promoted, the client component's
 *      `initialStepFor` puts them on Step 6 directly.
 */
export default async function RebuildPage({ params }: PageProps) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { id } = parsed.data;

  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/signin?callbackUrl=${encodeURIComponent(`/rebuilds/${id}`)}`);
  }
  const userId = session.user.id;

  const rebuildRow = await getRebuild(id, userId);
  if (!rebuildRow) notFound();

  const dto = toRebuildDto(rebuildRow);

  // Fetch profile slabs and source-session context in parallel.
  // The profile loader respects `excludeProjects` / `excludeStories`
  // so a candidate who's opted out doesn't see their own data leak
  // into the picker. The source-session lookup runs only when the
  // rebuild was started from a session.
  const [profileCtx, sourceContext] = await Promise.all([
    loadRebuildProfileContext({
      userId,
      // The DB column is plain TEXT (not the enum) so a future
      // change to the theme list doesn't require a migration. The
      // value WAS validated against `rebuildQuestionThemeSchema` at
      // create time, so the cast here is a static tightening, not a
      // trust assertion.
      theme: rebuildRow.questionTheme as RebuildQuestionTheme | null,
    }),
    rebuildRow.sourceSessionId
      ? loadSourceContext({
          sessionId: rebuildRow.sourceSessionId,
          userId,
          improvementIndex: rebuildRow.sourceImprovementIndex,
        })
      : Promise.resolve(null),
  ]);

  // If the rebuild has no theme (rare — only when the user picks
  // "Start fresh" from a non-themed source), fall back to ALL of
  // the user's stories so the picker still has a useful menu.
  let allStories = profileCtx.stories;
  if (!rebuildRow.questionTheme) {
    const rows = await db
      .select()
      .from(schema.stories)
      .where(eq(schema.stories.userId, userId))
      .orderBy(schema.stories.theme, schema.stories.createdAt);
    allStories = rows;
  }

  return (
    <section className="mx-auto max-w-4xl px-6 py-10">
      <Link
        href={
          rebuildRow.sourceSessionId
            ? `/sessions/${rebuildRow.sourceSessionId}`
            : "/dashboard"
        }
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {rebuildRow.sourceSessionId ? "Back to report" : "Back to dashboard"}
      </Link>

      <header className="mt-6">
        <h1 className="text-3xl font-semibold tracking-tight">
          Practice rebuild
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Restructure your answer with help from your own profile. InterviewReplay
          critiques your draft against your evidence — it doesn&apos;t write
          the answer for you.
        </p>
      </header>

      <div className="mt-10">
        <RebuildFlow
          initialRebuild={dto}
          sourceContext={sourceContext}
          matchingStories={profileCtx.stories.map(toStoryDto)}
          allStories={allStories.map(toStoryDto)}
          projects={profileCtx.projects.map(toProjectDto)}
        />
      </div>
    </section>
  );
}

/**
 * Resolve the source-session banner copy. A missing session,
 * missing report, or out-of-range improvement index all collapse
 * to `null` — the client just doesn't render the banner.
 *
 * `void listRebuildsForSession;` keeps the import hot for a future
 * "you have N rebuilds for this session" subhead without churning
 * the imports map; remove if that feature is dropped.
 */
async function loadSourceContext(args: {
  sessionId: string;
  userId: string;
  improvementIndex: number | null;
}): Promise<SourceImprovementContext | null> {
  void listRebuildsForSession;

  const [sessionRow] = await db
    .select({
      id: schema.interviewSessions.id,
      userId: schema.interviewSessions.userId,
      companyName: schema.interviewSessions.companyName,
      roundType: schema.interviewSessions.roundType,
      deletedAt: schema.interviewSessions.deletedAt,
    })
    .from(schema.interviewSessions)
    .where(eq(schema.interviewSessions.id, args.sessionId))
    .limit(1);

  if (
    !sessionRow ||
    sessionRow.userId !== args.userId ||
    sessionRow.deletedAt
  ) {
    return null;
  }

  const sessionLabel = `${sessionRow.companyName} ${prettyRoundType(
    sessionRow.roundType,
  )} round`;

  // The banner is also useful WITHOUT a specific improvement —
  // e.g. when a user starts a rebuild from the bottom-of-report
  // section but the improvementIndex didn't get persisted for
  // some reason. We still want to anchor the banner with the
  // session label.
  if (args.improvementIndex == null) {
    return { improvementSummary: null, sessionLabel };
  }

  // Latest report by `created_at` — re-analyses APPEND new rows
  // rather than overwrite, so a session may have multiple reports.
  // The rebuild's `source_improvement_index` was captured against
  // whatever was the latest report at rebuild-creation time; we use
  // the latest one here too. The improvement at that index might
  // not be the same one originally pointed at if the user re-
  // analyzed after starting the rebuild — `extractImprovementSummary`
  // is null-safe in that case and the banner just falls back to
  // the session label without the per-improvement headline.
  const [reportRow] = await db
    .select({ reportJson: schema.reports.reportJson })
    .from(schema.reports)
    .where(eq(schema.reports.sessionId, args.sessionId))
    .orderBy(desc(schema.reports.createdAt))
    .limit(1);

  const improvementSummary = extractImprovementSummary(
    reportRow?.reportJson,
    args.improvementIndex,
  );

  return { improvementSummary, sessionLabel };
}

function extractImprovementSummary(
  report: unknown,
  index: number,
): string | null {
  // We don't re-parse with `reportSchema` here because:
  //   (a) it's been validated at write time,
  //   (b) the banner copy is best-effort, so a malformed report
  //       row from an old rubric should hide the banner rather
  //       than throw.
  if (!report || typeof report !== "object") return null;
  const improvements = (report as { improvements?: unknown }).improvements;
  if (!Array.isArray(improvements)) return null;
  const item = improvements[index] as Report["improvements"][number] | undefined;
  if (!item || typeof item !== "object") return null;
  // Prefer `action` (the "Try this next time" copy) — it's the
  // most concrete handle for what the user is rebuilding. Fall
  // back to `heading` so we still surface SOMETHING for older
  // reports where action might be terse.
  const action = (item as { action?: unknown }).action;
  if (typeof action === "string" && action.trim().length > 0) {
    return action.trim();
  }
  const heading = (item as { heading?: unknown }).heading;
  if (typeof heading === "string" && heading.trim().length > 0) {
    return heading.trim();
  }
  return null;
}

function prettyRoundType(roundType: string): string {
  switch (roundType) {
    case "coding":
      return "coding";
    case "system_design":
      return "system design";
    case "behavioral":
      return "behavioral";
    default:
      return roundType.replace(/_/g, " ");
  }
}
