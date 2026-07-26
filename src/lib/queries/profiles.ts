import "server-only";

import { and, asc, desc, eq, isNull, max, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  Project,
  ResumeParseJob,
  Story,
  StoryTheme,
  UserProfile,
} from "@/lib/db/schema";

import type { ProfileExcludeField } from "@/lib/profiles/schemas";

/**
 * Read-side queries for the user-profile feature.
 *
 * Every query takes `userId` and pins the WHERE on it. The
 * dashboard, the `/profile` page, the API routes, and the analyze
 * worker should all funnel through here so the ownership filter is
 * impossible to skip.
 *
 * Reads return plain Drizzle row types (no DTO mapping) — the API
 * route serializes these straight to JSON. The DB columns ARE our
 * wire shape; if a column ever grows internal-only metadata, we'll
 * project it out at the route boundary, not here.
 */

/* ────────────────────────────────────────────────────────────── */
/* user_profiles                                                  */
/* ────────────────────────────────────────────────────────────── */

/**
 * Fetch the user's profile row, or `null` if they've never saved
 * anything. The route handler treats `null` as "all-defaults profile"
 * and serializes accordingly.
 */
export async function getProfile(userId: string): Promise<UserProfile | null> {
  const [row] = await db
    .select()
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * "Section last updated" timestamps for each of the four profile
 * sections. Used by the UI banner to render
 * "Resume last updated 2 days ago" without requiring callers to
 * understand which fields belong to which section.
 *
 * Resume + target are simple column reads off `user_profiles`.
 * Projects + stories are MAX(updated_at) aggregates because each
 * lives in its own table — caching a column on `user_profiles`
 * would drift the moment a row is inserted/deleted/updated.
 */
export interface SectionTimestamps {
  resume: Date | null;
  projects: Date | null;
  stories: Date | null;
  target: Date | null;
}

export async function getSectionTimestamps(
  userId: string,
): Promise<SectionTimestamps> {
  // Run all three queries in parallel — they don't depend on each
  // other and a sequential await chain would cost ~3 RTTs for no
  // reason.
  const [profileRow, projectsAgg, storiesAgg] = await Promise.all([
    db
      .select({
        resumeUpdatedAt: schema.userProfiles.resumeUpdatedAt,
        targetUpdatedAt: schema.userProfiles.targetUpdatedAt,
      })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId))
      .limit(1),
    db
      .select({ at: max(schema.projects.updatedAt) })
      .from(schema.projects)
      .where(eq(schema.projects.userId, userId)),
    db
      .select({ at: max(schema.stories.updatedAt) })
      .from(schema.stories)
      .where(eq(schema.stories.userId, userId)),
  ]);

  return {
    resume: profileRow[0]?.resumeUpdatedAt ?? null,
    projects: projectsAgg[0]?.at ?? null,
    stories: storiesAgg[0]?.at ?? null,
    target: profileRow[0]?.targetUpdatedAt ?? null,
  };
}

/**
 * Lightweight projection used by the dashboard's profile-completeness
 * banner. We compute the section flags ("has any data?") in one
 * round-trip rather than dragging the whole row into a render that
 * only needs flags.
 *
 * The "complete" definition is intentionally generous — the goal is
 * to nudge candidates who haven't started, not to gate functionality.
 *
 * The `stories` flag is kept on the wire for backwards compat with
 * call sites that already destructure it, but it does NOT count
 * toward the `fraction` (Story bank is its own top-level surface
 * now). The dashboard's stand-alone "Story bank: N" pill carries
 * that signal independently.
 */
export interface ProfileCompleteness {
  resume: boolean;
  projects: boolean;
  stories: boolean;
  target: boolean;
  /** 0-1 range for a progress bar. */
  fraction: number;
}

export async function getProfileCompleteness(
  userId: string,
): Promise<ProfileCompleteness> {
  const [profileRow, projectCount, storyCount] = await Promise.all([
    db
      .select({
        currentRole: schema.userProfiles.currentRole,
        yearsOfExperience: schema.userProfiles.yearsOfExperience,
        companies: schema.userProfiles.companies,
        levels: schema.userProfiles.levels,
        targetCompanies: schema.userProfiles.targetCompanies,
        careerNarrative: schema.userProfiles.careerNarrative,
      })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId))
      .limit(1),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.projects)
      .where(eq(schema.projects.userId, userId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.stories)
      .where(eq(schema.stories.userId, userId)),
  ]);

  const p = profileRow[0];
  const resumeDone = Boolean(
    p &&
      (p.currentRole ||
        p.yearsOfExperience != null ||
        (Array.isArray(p.companies) && p.companies.length > 0)),
  );
  const projectsDone = (projectCount[0]?.n ?? 0) > 0;
  const storiesDone = (storyCount[0]?.n ?? 0) > 0;
  const targetDone = Boolean(
    p &&
      ((Array.isArray(p.levels) && p.levels.length > 0) ||
        (Array.isArray(p.targetCompanies) && p.targetCompanies.length > 0) ||
        p.careerNarrative),
  );

  // Story bank is its own top-level page; `storiesDone` is still
  // returned for backwards compat with the dashboard's separate
  // pill, but the profile completeness fraction is over 3 sections
  // (resume / projects / target).
  const filled = [resumeDone, projectsDone, targetDone].filter(Boolean).length;

  return {
    resume: resumeDone,
    projects: projectsDone,
    stories: storiesDone,
    target: targetDone,
    fraction: filled / 3,
  };
}

/* ────────────────────────────────────────────────────────────── */
/* projects                                                       */
/* ────────────────────────────────────────────────────────────── */

/**
 * List the user's projects in display order. The UI renders the
 * cards in this order; the analyze worker reads the same shape so
 * the LLM sees the candidate's prioritization.
 *
 * Hits `projects_user_order_idx`.
 */
export async function listProjects(userId: string): Promise<Project[]> {
  return db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.userId, userId))
    .orderBy(asc(schema.projects.displayOrder), asc(schema.projects.createdAt));
}

/**
 * Fetch one project if (and only if) it belongs to the given user.
 * Returns `null` for both "not found" and "owned by someone else"
 * — the API boundary deliberately doesn't disclose the difference.
 */
export async function getProject(
  projectId: string,
  userId: string,
): Promise<Project | null> {
  const [row] = await db
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function countProjects(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.projects)
    .where(eq(schema.projects.userId, userId));
  return row?.n ?? 0;
}

/* ────────────────────────────────────────────────────────────── */
/* stories                                                        */
/* ────────────────────────────────────────────────────────────── */

/**
 * List the user's stories. Default order matches the themes module
 * grouping (theme, then created_at) so the UI can stable-sort into
 * its grouped layout without an extra pass.
 */
export async function listStories(userId: string): Promise<Story[]> {
  return db
    .select()
    .from(schema.stories)
    .where(eq(schema.stories.userId, userId))
    .orderBy(asc(schema.stories.theme), asc(schema.stories.createdAt));
}

/**
 * Group the user's stories by theme. Themes with no stories are
 * NOT included here — the UI renders empty placeholders by walking
 * `STORY_THEMES` and merging this map.
 */
export async function listStoriesByTheme(
  userId: string,
): Promise<Map<StoryTheme, Story[]>> {
  const rows = await listStories(userId);
  const grouped = new Map<StoryTheme, Story[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.theme);
    if (bucket) bucket.push(row);
    else grouped.set(row.theme, [row]);
  }
  return grouped;
}

export async function getStory(
  storyId: string,
  userId: string,
): Promise<Story | null> {
  const [row] = await db
    .select()
    .from(schema.stories)
    .where(
      and(eq(schema.stories.id, storyId), eq(schema.stories.userId, userId)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Same shape as `listStoriesWithRebuilds`, but scoped to one
 * story. Used by the `/stories/[id]` detail page to load the
 * single row + rebuild context + source session header in one
 * round-trip. Returns `null` for "not found" and "owned by
 * someone else" — the caller treats both as 404 to avoid
 * disclosing which is which.
 *
 * Carries the same cross-tenant + soft-delete defenses as
 * `listStoriesWithRebuilds`; see that function for the rationale.
 */
export async function getStoryWithRebuild(
  storyId: string,
  userId: string,
): Promise<StoryWithRebuild | null> {
  const rows = await db
    .select({
      story: schema.stories,
      rebuild: {
        id: schema.storyRebuilds.id,
        sourceSessionId: schema.storyRebuilds.sourceSessionId,
        sourceImprovementIndex: schema.storyRebuilds.sourceImprovementIndex,
        aiCritiqueJson: schema.storyRebuilds.aiCritiqueJson,
        aiSuggestedResponseJson: schema.storyRebuilds.aiSuggestedResponseJson,
        aiSuggestedResponseGeneratedAt:
          schema.storyRebuilds.aiSuggestedResponseGeneratedAt,
        updatedAt: schema.storyRebuilds.updatedAt,
      },
      sourceSession: {
        id: schema.interviewSessions.id,
        companyName: schema.interviewSessions.companyName,
        roundType: schema.interviewSessions.roundType,
        createdAt: schema.interviewSessions.createdAt,
      },
    })
    .from(schema.stories)
    .leftJoin(
      schema.storyRebuilds,
      and(
        eq(schema.storyRebuilds.promotedToStoryId, schema.stories.id),
        eq(schema.storyRebuilds.userId, schema.stories.userId),
      ),
    )
    .leftJoin(
      schema.interviewSessions,
      and(
        eq(
          schema.interviewSessions.id,
          schema.storyRebuilds.sourceSessionId,
        ),
        eq(schema.interviewSessions.userId, schema.stories.userId),
        isNull(schema.interviewSessions.deletedAt),
      ),
    )
    .where(
      and(
        eq(schema.stories.id, storyId),
        eq(schema.stories.userId, userId),
      ),
    )
    .limit(1);

  const r = rows[0];
  if (!r) return null;

  const rebuild =
    r.rebuild && r.rebuild.id !== null
      ? {
          id: r.rebuild.id,
          sourceSessionId: r.rebuild.sourceSessionId,
          sourceImprovementIndex: r.rebuild.sourceImprovementIndex,
          aiCritiqueJson: r.rebuild.aiCritiqueJson,
          aiSuggestedResponseJson: r.rebuild.aiSuggestedResponseJson,
          aiSuggestedResponseGeneratedAt:
            r.rebuild.aiSuggestedResponseGeneratedAt,
          updatedAt: r.rebuild.updatedAt!,
        }
      : null;
  const sourceSession =
    r.sourceSession && r.sourceSession.id !== null
      ? {
          id: r.sourceSession.id,
          companyName: r.sourceSession.companyName!,
          roundType: r.sourceSession.roundType!,
          createdAt: r.sourceSession.createdAt!,
        }
      : null;

  return { story: r.story, rebuild, sourceSession };
}

/**
 * One row carries a `Story` plus the rebuild it came from (if any)
 * plus the source session header (if any). The Story Bank page
 * walks this list and renders each card with a "From Practice
 * Rebuild" badge + "View AI critique" expander when a rebuild is
 * attached.
 *
 * The shape is intentionally stable / wide so the route layer can
 * map straight to `StoryWithRebuildDto` without a second
 * round-trip.
 */
export interface StoryWithRebuild {
  story: Story;
  /** Null when the story wasn't promoted from a rebuild. */
  rebuild: {
    id: string;
    sourceSessionId: string | null;
    sourceImprovementIndex: number | null;
    aiCritiqueJson: unknown;
    aiSuggestedResponseJson: unknown;
    aiSuggestedResponseGeneratedAt: Date | null;
    updatedAt: Date;
  } | null;
  /** Null when no rebuild OR rebuild's session was deleted. */
  sourceSession: {
    id: string;
    companyName: string;
    roundType: string;
    createdAt: Date;
  } | null;
}

/**
 * List the user's stories with their rebuild context (if any) for
 * the Story Bank page. LEFT JOINs `story_rebuilds` on
 * `promoted_to_story_id = stories.id` so stories that were
 * hand-authored have `rebuild === null`. Also LEFT JOINs
 * `interview_sessions` so the card can render the session header
 * without a follow-up query — sessions that were retention-swept
 * yield `sourceSession === null` even when `rebuild` is set.
 *
 * Each story has at most one promoted rebuild
 * (`saveRebuildToBank` always inserts a fresh `stories` row), but
 * if a future bug or manual SQL produces a duplicate join row we
 * dedupe in JS keyed by `story.id`, picking the most-recent
 * rebuild by `updatedAt`.
 *
 * Cross-tenant + soft-delete defenses on the joins:
 *   - `story_rebuilds.user_id = stories.user_id` constrains the
 *     rebuild join to the caller's own rows. The schema invariant
 *     already implies this (a rebuild and its promoted story
 *     share an owner), but the explicit predicate hardens the
 *     read against any future bug that would let a rebuild dangle
 *     across users.
 *   - `interview_sessions.user_id = stories.user_id` is the same
 *     defense-in-depth on the session join — `source_session_id`
 *     is supposed to point at the user's own session, but a
 *     future schema corruption shouldn't be able to leak another
 *     user's company name into the bank page.
 *   - `interview_sessions.deleted_at IS NULL` keeps soft-deleted
 *     sessions out. A session the user soft-deleted should not
 *     surface its `companyName` / `roundType` via the rebuild
 *     backlink — the card falls back to "Source session
 *     unavailable" the same way it does for hard-deleted rows.
 *
 * Hits the new `story_rebuilds_promoted_to_story_idx` partial
 * index on the join condition.
 */
export async function listStoriesWithRebuilds(
  userId: string,
): Promise<StoryWithRebuild[]> {
  const rows = await db
    .select({
      story: schema.stories,
      rebuild: {
        id: schema.storyRebuilds.id,
        sourceSessionId: schema.storyRebuilds.sourceSessionId,
        sourceImprovementIndex: schema.storyRebuilds.sourceImprovementIndex,
        aiCritiqueJson: schema.storyRebuilds.aiCritiqueJson,
        aiSuggestedResponseJson: schema.storyRebuilds.aiSuggestedResponseJson,
        aiSuggestedResponseGeneratedAt:
          schema.storyRebuilds.aiSuggestedResponseGeneratedAt,
        updatedAt: schema.storyRebuilds.updatedAt,
      },
      sourceSession: {
        id: schema.interviewSessions.id,
        companyName: schema.interviewSessions.companyName,
        roundType: schema.interviewSessions.roundType,
        createdAt: schema.interviewSessions.createdAt,
      },
    })
    .from(schema.stories)
    .leftJoin(
      schema.storyRebuilds,
      and(
        eq(schema.storyRebuilds.promotedToStoryId, schema.stories.id),
        eq(schema.storyRebuilds.userId, schema.stories.userId),
      ),
    )
    .leftJoin(
      schema.interviewSessions,
      and(
        eq(
          schema.interviewSessions.id,
          schema.storyRebuilds.sourceSessionId,
        ),
        eq(schema.interviewSessions.userId, schema.stories.userId),
        isNull(schema.interviewSessions.deletedAt),
      ),
    )
    .where(eq(schema.stories.userId, userId))
    .orderBy(asc(schema.stories.theme), asc(schema.stories.createdAt));

  // Dedupe by story.id — defense against the (logically
  // impossible but cheap to defend) "two rebuilds promoted to the
  // same story" case. Most-recent rebuild wins.
  const byStory = new Map<string, StoryWithRebuild>();
  for (const r of rows) {
    const existing = byStory.get(r.story.id);
    const rebuild =
      r.rebuild && r.rebuild.id !== null
        ? {
            id: r.rebuild.id,
            sourceSessionId: r.rebuild.sourceSessionId,
            sourceImprovementIndex: r.rebuild.sourceImprovementIndex,
            aiCritiqueJson: r.rebuild.aiCritiqueJson,
            aiSuggestedResponseJson: r.rebuild.aiSuggestedResponseJson,
            aiSuggestedResponseGeneratedAt:
              r.rebuild.aiSuggestedResponseGeneratedAt,
            updatedAt: r.rebuild.updatedAt!,
          }
        : null;
    const sourceSession =
      r.sourceSession && r.sourceSession.id !== null
        ? {
            id: r.sourceSession.id,
            companyName: r.sourceSession.companyName!,
            roundType: r.sourceSession.roundType!,
            createdAt: r.sourceSession.createdAt!,
          }
        : null;

    if (
      !existing ||
      // Upgrade existing entry if the new row has a rebuild and the
      // existing entry has none (the LEFT JOIN produced a null row first,
      // then a matched row second).
      (rebuild && !existing.rebuild) ||
      // Or keep the most-recently-updated rebuild when there are two.
      (rebuild &&
        existing.rebuild &&
        rebuild.updatedAt.getTime() > existing.rebuild.updatedAt.getTime())
    ) {
      byStory.set(r.story.id, {
        story: r.story,
        rebuild,
        sourceSession,
      });
    }
  }

  // Preserve the ORDER BY (theme asc, created_at asc) — Map
  // iteration honors insertion order, so as long as we set the
  // most-recent dedupe winner LAST under the same key, it
  // overwrites in place. The first insertion under a key
  // determined the position; that's exactly what we want.
  return Array.from(byStory.values());
}

/* ────────────────────────────────────────────────────────────── */
/* resume_parse_jobs                                              */
/* ────────────────────────────────────────────────────────────── */

/**
 * Polling endpoint helper. Returns the job iff it belongs to the
 * caller. The unique index `resume_parse_jobs_id_user_uniq` makes
 * this a single-row lookup.
 */
export async function getResumeParseJob(
  jobId: string,
  userId: string,
): Promise<ResumeParseJob | null> {
  const [row] = await db
    .select()
    .from(schema.resumeParseJobs)
    .where(
      and(
        eq(schema.resumeParseJobs.id, jobId),
        eq(schema.resumeParseJobs.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Most recent parse job for the user. Used by the UI on first
 * render: if there's a `pending`/`processing` job, the resume
 * section auto-resumes its polling state without forcing the user
 * to click Upload again. Returns `null` when the user has never
 * uploaded.
 */
export async function getMostRecentResumeParseJob(
  userId: string,
): Promise<ResumeParseJob | null> {
  const [row] = await db
    .select()
    .from(schema.resumeParseJobs)
    .where(eq(schema.resumeParseJobs.userId, userId))
    .orderBy(desc(schema.resumeParseJobs.createdAt))
    .limit(1);
  return row ?? null;
}

/* ────────────────────────────────────────────────────────────── */
/* Section-by-section read for the analyze worker                 */
/* ────────────────────────────────────────────────────────────── */

/**
 * Resolved profile snapshot the analyze worker uses to build its
 * per-session prompt. Every section is included only if its
 * `exclude_*` flag is `false` AND the section actually has data.
 *
 * The worker calls this exactly once per analyze; nothing in the
 * hot recording loop reads it.
 */
export interface ResolvedProfile {
  resume: {
    yearsOfExperience: number | null;
    currentRole: string | null;
    professionalSummary: string | null;
    companies: UserProfile["companies"];
    technologies: UserProfile["technologies"];
    education: UserProfile["education"];
  } | null;
  projects: Project[] | null;
  stories: Story[] | null;
  target: {
    levels: UserProfile["levels"];
    targetCompanies: UserProfile["targetCompanies"];
    careerNarrative: string | null;
  } | null;
}

export async function getResolvedProfileForAnalyze(
  userId: string,
): Promise<ResolvedProfile> {
  const profile = await getProfile(userId);
  if (!profile) {
    return { resume: null, projects: null, stories: null, target: null };
  }

  const [projects, stories] = await Promise.all([
    profile.excludeProjects ? Promise.resolve([] as Project[]) : listProjects(userId),
    profile.excludeStories ? Promise.resolve([] as Story[]) : listStories(userId),
  ]);

  return {
    resume: profile.excludeResume
      ? null
      : {
          yearsOfExperience: profile.yearsOfExperience,
          currentRole: profile.currentRole,
          professionalSummary: profile.professionalSummary,
          companies: profile.companies,
          technologies: profile.technologies,
          education: profile.education,
        },
    projects: profile.excludeProjects ? null : projects,
    stories: profile.excludeStories ? null : stories,
    target: profile.excludeTarget
      ? null
      : {
          levels: profile.levels,
          targetCompanies: profile.targetCompanies,
          careerNarrative: profile.careerNarrative,
        },
  };
}

/**
 * Map an exclude-field literal back to the matching DB column.
 * Centralized so the API route + the analyze worker can't drift.
 */
export function excludeColumnFor(field: ProfileExcludeField) {
  switch (field) {
    case "resume":
      return schema.userProfiles.excludeResume;
    case "projects":
      return schema.userProfiles.excludeProjects;
    case "stories":
      return schema.userProfiles.excludeStories;
    case "target":
      return schema.userProfiles.excludeTarget;
  }
}
