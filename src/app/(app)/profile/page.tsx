import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ProfilePage } from "@/components/profile/profile-page";
import { auth } from "@/lib/auth";
import { emptyProfileDto, toProfileDto } from "@/lib/profiles/dto";
import {
  getMostRecentResumeParseJob,
  getProfile,
  getProfileCompleteness,
  getSectionTimestamps,
  listProjects,
} from "@/lib/queries/profiles";
import { toProjectDto, toResumeParseJobDto } from "@/lib/profiles/dto";

export const metadata: Metadata = {
  title: "Profile",
};

export const dynamic = "force-dynamic";

/**
 * `/profile` — three collapsible sections (Resume, Projects,
 * Target). The behavioral story bank moved to its own top-level
 * page at `/stories` so saved Practice Rebuilds can surface their
 * AI critique + source-session backlink.
 *
 * The (app) layout already redirects unauthenticated traffic; we
 * re-derive `userId` here so all server-side reads are
 * ownership-pinned.
 */
export default async function Page() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  const userId = session.user.id;

  // Parallel reads — none of these depend on each other. We no
  // longer hydrate stories here; the /stories page owns that.
  const [profile, projects, sectionTimestamps, completeness, latestJob] =
    await Promise.all([
      getProfile(userId),
      listProjects(userId),
      getSectionTimestamps(userId),
      getProfileCompleteness(userId),
      getMostRecentResumeParseJob(userId),
    ]);

  const profileDto = profile ? toProfileDto(profile) : emptyProfileDto();
  const projectsDto = projects.map(toProjectDto);
  const latestJobDto = latestJob ? toResumeParseJobDto(latestJob) : null;

  return (
    <section className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The richer this is, the better your interview feedback. Everything
          here is private — only your account and our analysis pipeline read
          it.
        </p>
      </header>

      <ProfilePage
        initialProfile={profileDto}
        initialProjects={projectsDto}
        initialLatestParseJob={latestJobDto}
        initialSectionTimestamps={{
          resume: sectionTimestamps.resume?.toISOString() ?? null,
          projects: sectionTimestamps.projects?.toISOString() ?? null,
          target: sectionTimestamps.target?.toISOString() ?? null,
        }}
        initialCompleteness={completeness}
      />
    </section>
  );
}
