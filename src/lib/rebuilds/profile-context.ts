import "server-only";

import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  Project,
  RebuildQuestionTheme,
  Story,
  UserProfile,
} from "@/lib/db/schema";

/**
 * Profile context for the critique prompt.
 *
 * The "profile-grounded feedback" half of Practice Rebuild only
 * works if the model has a fully-resolved snapshot of the
 * candidate's profile to point at. This module:
 *
 *   1. Reads the relevant slabs of profile data (resume, projects,
 *      theme-matching stories), respecting the per-section
 *      `exclude_*` toggles the candidate set on /profile.
 *   2. Renders them into a stable, deterministic Markdown block
 *      the prompt builder splices in BEFORE the candidate's draft.
 *   3. Returns the same data as a structured object so guardrail
 *      #2 can verify that any `profile_reference.field_value` the
 *      model emits actually appears VERBATIM in the source. If a
 *      claimed value isn't in here, the model hallucinated it and
 *      the guardrail trips.
 *
 * The exclude toggles deliberately apply: a candidate who has set
 * "exclude my projects from analysis" doesn't expect their projects
 * to suddenly leak into the rebuild critique just because they're
 * on a different surface. Same posture as the analyze worker.
 */

/**
 * Source-of-truth bundle the rest of the critique pipeline reads.
 * Each entry carries the raw row so the renderer can format it AND
 * the guardrail layer can hash-compare verbatim against the
 * model's output.
 */
export interface RebuildProfileContext {
  /** Resume slab — null when excluded or absent. */
  resume:
    | (Pick<
        UserProfile,
        | "yearsOfExperience"
        | "currentRole"
        | "professionalSummary"
        | "careerNarrative"
        | "levels"
      > & {
        targetCompanies: UserProfile["targetCompanies"];
      })
    | null;
  projects: Project[];
  /**
   * Stories the prompt's "stories matching theme" block surfaces.
   * If `theme` is provided we filter to that theme; otherwise all
   * stories are included.
   */
  stories: Story[];
}

export async function loadRebuildProfileContext(args: {
  userId: string;
  theme: RebuildQuestionTheme | null;
}): Promise<RebuildProfileContext> {
  // One round-trip for the profile row (which carries the
  // exclude flags), then parallel reads for projects + stories
  // gated by those flags.
  const [profileRow] = await db
    .select()
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, args.userId))
    .limit(1);

  if (!profileRow) {
    return { resume: null, projects: [], stories: [] };
  }

  const projectsP: Promise<Project[]> = profileRow.excludeProjects
    ? Promise.resolve([])
    : db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.userId, args.userId))
        .orderBy(schema.projects.displayOrder, schema.projects.createdAt);

  // Story filtering: if the candidate tagged a theme on the
  // rebuild, narrow to that theme. Otherwise include everything
  // — the prompt asks the model to look across all stories. We
  // do the theme filter at the SQL layer so a candidate with 60
  // stories doesn't ship 59 irrelevant rows in the prompt.
  const storiesP: Promise<Story[]> = profileRow.excludeStories
    ? Promise.resolve([])
    : args.theme
      ? db
          .select()
          .from(schema.stories)
          .where(
            and(
              eq(schema.stories.userId, args.userId),
              eq(schema.stories.theme, args.theme),
            ),
          )
          .orderBy(schema.stories.createdAt)
      : db
          .select()
          .from(schema.stories)
          .where(eq(schema.stories.userId, args.userId))
          .orderBy(schema.stories.theme, schema.stories.createdAt);

  const [projects, stories] = await Promise.all([projectsP, storiesP]);

  const resume = profileRow.excludeResume && profileRow.excludeTarget
    ? null
    : {
        yearsOfExperience: profileRow.yearsOfExperience,
        currentRole: profileRow.currentRole,
        professionalSummary: profileRow.excludeResume
          ? null
          : profileRow.professionalSummary,
        careerNarrative: profileRow.excludeTarget
          ? null
          : profileRow.careerNarrative,
        levels: profileRow.excludeTarget ? null : profileRow.levels,
        targetCompanies: profileRow.excludeTarget
          ? null
          : profileRow.targetCompanies,
      };

  return { resume, projects, stories };
}

/**
 * Render the profile context as Markdown the prompt builder
 * splices in before the candidate's draft. The format is
 * deterministic — guardrail tests pin the exact wording — and
 * mirrors the structure the system prompt's "CANDIDATE PROFILE"
 * section describes.
 *
 * Exported separately from the loader so tests can render a
 * synthetic context without a DB hit.
 */
export function renderProfileContext(
  ctx: RebuildProfileContext,
  args: { theme: RebuildQuestionTheme | null },
): string {
  const lines: string[] = [];

  lines.push("CANDIDATE PROFILE — for fact-checking and evidence-pointing only:");
  lines.push("");

  // Resume / target preamble. Even when both slabs are excluded
  // we still emit "not provided" lines so the model's prompt
  // reads consistently across users.
  const r = ctx.resume;
  lines.push(
    `Career narrative: ${r?.careerNarrative?.trim() ? r.careerNarrative.trim() : "not provided"}`,
  );
  lines.push(
    `Years of experience: ${r?.yearsOfExperience != null ? String(r.yearsOfExperience) : "not provided"}`,
  );
  lines.push(
    `Current role: ${r?.currentRole?.trim() ? r.currentRole.trim() : "not provided"}`,
  );
  lines.push(
    `Target levels: ${
      Array.isArray(r?.levels) && r.levels.length > 0
        ? r.levels.join(", ")
        : "not provided"
    }`,
  );
  lines.push("");

  /* Projects ───────────────────────────────────────────── */
  lines.push("Projects:");
  if (ctx.projects.length === 0) {
    lines.push("  (No projects in profile.)");
  } else {
    for (const p of ctx.projects) {
      lines.push(`  - Project ID: ${p.id}`);
      lines.push(`    Name: ${oneLine(p.name)}`);
      lines.push(`    Company: ${oneLine(p.companyContext)}`);
      lines.push(`    Time period: ${oneLine(p.timePeriod)}`);
      lines.push(`    Scale: ${oneLine(p.scaleDescription)}`);
      lines.push(`    Team size: ${oneLine(p.teamSize)}`);
      lines.push(`    My role: ${oneLine(p.myRole)}`);
      lines.push(`    Key decisions: ${oneLine(p.keyDecisions)}`);
      lines.push(`    Outcomes with metrics: ${oneLine(p.outcomesWithMetrics)}`);
    }
  }
  lines.push("");

  /* Stories ────────────────────────────────────────────── */
  const storyHeading = args.theme
    ? `Stories matching theme '${args.theme}':`
    : "Stories (no theme filter — show all):";
  lines.push(storyHeading);
  if (ctx.stories.length === 0) {
    lines.push("  (No matching stories in profile.)");
  } else {
    for (const s of ctx.stories) {
      lines.push(`  - Story ID: ${s.id}`);
      lines.push(`    Title: ${oneLine(s.title)}`);
      lines.push(`    Situation: ${oneLine(s.situation)}`);
      lines.push(`    Task: ${oneLine(s.task)}`);
      lines.push(`    Action: ${oneLine(s.action)}`);
      lines.push(`    Result: ${oneLine(s.result)}`);
      lines.push(`    What I learned: ${oneLine(s.whatILearned)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Returns true when the profile has no usable content — no resume
 * row, no projects, and no stories. When this is true, calling the
 * LLM will produce purely generic text (every profile field is
 * "not provided"), which is worse than telling the user to fill in
 * their profile first.
 *
 * Sparse profiles (resume present but no projects, or a couple of
 * stories with thin fields) are NOT considered empty here — the
 * LLM caveats mechanism handles them, and a partial draft is still
 * more useful than a "go fill your profile" message.
 */
export function isProfileContextEmpty(ctx: RebuildProfileContext): boolean {
  return ctx.resume === null && ctx.projects.length === 0 && ctx.stories.length === 0;
}

function oneLine(value: string | null | undefined): string {
  if (value == null) return "(not provided)";
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return "(not provided)";
  // Collapse internal newlines so the rendered prompt stays in
  // the structured, scannable shape the model expects. The
  // whitespace-normalized verbatim check in guardrail 2 also
  // collapses newlines, so the verbatim assertion still holds.
  return trimmed.replace(/\s+/g, " ");
}
