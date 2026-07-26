import { ChevronLeft, ExternalLink, Wrench } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { CritiqueView } from "@/components/app/critique-view";
import { SuggestedResponseView } from "@/components/app/suggested-response-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import { toStoryWithRebuildDto } from "@/lib/profiles/dto";
import { STORY_THEMES } from "@/lib/profiles/themes";
import { getStoryWithRebuild } from "@/lib/queries/profiles";

export const metadata: Metadata = {
  title: "Story",
};

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * `/stories/[id]` — full detail view of a single saved story.
 *
 * Renders:
 *   - The full STAR fields (uncollapsed; the bank list is the
 *     condensed view).
 *   - The full AI critique via `<CritiqueView variant="full" />`
 *     when the story came from a Practice Rebuild.
 *   - "Open rebuild" + "View source session" affordances when
 *     the rebuild / source session still exist.
 *
 * Returns 404 (via `notFound()`) for unknown ids and
 * other-user-owned ids alike — we don't disclose which.
 */
export default async function Page({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  const userId = session.user.id;

  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const row = await getStoryWithRebuild(parsed.data.id, userId);
  if (!row) notFound();

  const dto = toStoryWithRebuildDto(row);
  const themeLabel =
    STORY_THEMES.find((t) => t.value === dto.theme)?.label ?? dto.theme;

  return (
    <section className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6">
        <Button asChild variant="ghost" size="sm">
          <Link href="/stories">
            <ChevronLeft className="size-4" aria-hidden /> Story bank
          </Link>
        </Button>
      </div>

      <header className="mb-6 space-y-3">
        <Badge variant="secondary">{themeLabel}</Badge>
        <h1 className="text-2xl font-semibold tracking-tight">{dto.title}</h1>
        {dto.rebuild ? (
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {dto.rebuild.sourceSession ? (
              <span>
                From interview ·{" "}
                <Link
                  href={`/sessions/${dto.rebuild.sourceSession.id}`}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {dto.rebuild.sourceSession.companyName}
                </Link>
              </span>
            ) : dto.rebuild.sourceSessionId ? (
              <span>Source session unavailable (deleted)</span>
            ) : null}
            <Button asChild variant="ghost" size="sm">
              <Link href={`/rebuilds/${dto.rebuild.id}`}>
                <Wrench className="size-4" aria-hidden /> Open rebuild
              </Link>
            </Button>
            {dto.rebuild.sourceSession ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={`/sessions/${dto.rebuild.sourceSession.id}`}>
                  <ExternalLink className="size-4" aria-hidden />
                  View source session
                </Link>
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="space-y-4 rounded-xl border border-border bg-background p-6">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          STAR
        </h2>
        <StarBlock label="Situation" value={dto.situation} />
        <StarBlock label="Task" value={dto.task} />
        <StarBlock label="Action" value={dto.action} />
        <StarBlock label="Result" value={dto.result} />
        <StarBlock label="What I learned" value={dto.whatILearned} />
      </div>

      {dto.rebuild?.aiCritique ? (
        <div className="mt-8 space-y-4">
          <h2 className="text-lg font-semibold">AI critique</h2>
          <CritiqueView critique={dto.rebuild.aiCritique} variant="full" />
        </div>
      ) : null}

      {/*
        Prefer the bank-surface (story-side) suggestion when
        present; fall back to the rebuild-side cached suggestion.
        Hand-authored stories only ever have the story-side
        column populated.
      */}
      {(() => {
        const suggestion =
          dto.aiSuggestedResponse ?? dto.rebuild?.aiSuggestedResponse ?? null;
        const generatedAt =
          dto.aiSuggestedResponseGeneratedAt ??
          dto.rebuild?.aiSuggestedResponseGeneratedAt ??
          null;
        if (!suggestion) return null;
        return (
          <div className="mt-8 space-y-4">
            <h2 className="text-lg font-semibold">AI suggested response</h2>
            <p className="text-sm text-muted-foreground">
              A draft InterviewReplay generated from your profile, projects, and stories.
              Read it alongside your saved version to spot gaps you can revise.
              Generation happens from the rebuild flow or your Story Bank —
              this page is read-only.
            </p>
            <div className="rounded-xl border border-border bg-background p-6">
              <SuggestedResponseView
                suggestion={suggestion}
                variant="full"
                generatedAt={generatedAt}
              />
            </div>
          </div>
        );
      })()}
    </section>
  );
}

function StarBlock({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 whitespace-pre-line text-sm">{value}</p>
    </div>
  );
}
