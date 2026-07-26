import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { StoryBankPage } from "@/components/app/story-bank-page";
import { auth } from "@/lib/auth";
import {
  emptyProfileDto,
  toProfileDto,
  toStoryWithRebuildDto,
} from "@/lib/profiles/dto";
import { getProfile, listStoriesWithRebuilds } from "@/lib/queries/profiles";

export const metadata: Metadata = {
  title: "Story bank",
};

export const dynamic = "force-dynamic";

/**
 * `/stories` — top-level Behavioral story bank.
 *
 * Used to live as a section inside `/profile`; promoted to its
 * own page so candidates can find their saved Practice Rebuild
 * outputs (with attached AI critique + source-session backlink)
 * without spelunking through profile sections.
 *
 * Server-loads stories augmented with their rebuild context via
 * `listStoriesWithRebuilds` (LEFT JOINs `story_rebuilds` and
 * `interview_sessions`). Mutations after first paint go through
 * the `/api/stories/*` and `/api/profile/exclude` routes from a
 * client island.
 */
export default async function Page() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  const userId = session.user.id;

  // Wrap in try/catch so a DB schema mismatch (e.g. a pending migration
  // that adds columns referenced by the query) degrades to an empty bank
  // rather than a hard RSC crash.
  let profile = null;
  let storiesWithRebuilds: Awaited<ReturnType<typeof listStoriesWithRebuilds>> =
    [];
  try {
    [profile, storiesWithRebuilds] = await Promise.all([
      getProfile(userId),
      listStoriesWithRebuilds(userId),
    ]);
  } catch (err) {
    console.error("[/stories] failed to load story data:", err);
  }

  const profileDto = profile ? toProfileDto(profile) : emptyProfileDto();
  const stories = storiesWithRebuilds.map(toStoryWithRebuildDto);

  return (
    <section className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Story bank</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your STAR-format stories, grouped by behavioral theme. Stories you
          built through Practice Rebuild keep their AI critique and a link
          back to the originating interview session.
        </p>
      </header>

      <StoryBankPage
        initialStories={stories}
        initialExcludeStories={profileDto.excludeStories}
        storiesMax={profileDto.limits.storiesMax}
      />
    </section>
  );
}
