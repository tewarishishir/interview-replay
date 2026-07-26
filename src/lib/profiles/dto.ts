import "server-only";

import type { Project, Story, UserProfile } from "@/lib/db/schema";
import type { ResumeParseJob } from "@/lib/db/schema";
import {
  critiqueResponseSchema,
  suggestedResponseSchema,
  type CritiqueResponse,
  type SuggestedResponse,
} from "@/lib/rebuilds/schemas";

import { PROFILE_LIMITS } from "./constants";

/**
 * DTO mappers for the profile feature. Responsibilities:
 *
 *   - Convert `Date` columns to ISO-8601 strings so the wire shape
 *     is JSON-clean (the client doesn't have to remember which
 *     fields are dates).
 *   - Strip internal-only columns we never want to leak (none today,
 *     but the boundary is the right place to enforce it).
 *   - Coalesce JSONB nulls to empty arrays where the UI expects a
 *     concrete list to map over.
 *
 * Tests assert on these shapes; if you add a public field to a
 * schema, remember to surface it here too.
 */

export interface ProfileDto {
  yearsOfExperience: number | null;
  currentRole: string | null;
  professionalSummary: string | null;
  companies: NonNullable<UserProfile["companies"]>;
  technologies: NonNullable<UserProfile["technologies"]>;
  education: NonNullable<UserProfile["education"]>;
  resumeSavedAt: string | null;
  levels: NonNullable<UserProfile["levels"]>;
  targetCompanies: NonNullable<UserProfile["targetCompanies"]>;
  careerNarrative: string | null;
  excludeResume: boolean;
  excludeProjects: boolean;
  excludeStories: boolean;
  excludeTarget: boolean;
  resumeUpdatedAt: string | null;
  targetUpdatedAt: string | null;
  updatedAt: string;
  /** PROFILE_LIMITS, echoed so the form can build counters. */
  limits: typeof PROFILE_LIMITS;
}

/**
 * Empty-defaults DTO for a brand-new user (no `user_profiles` row
 * yet). The UI treats this as "all sections empty, no exclusions".
 */
export function emptyProfileDto(): ProfileDto {
  return {
    yearsOfExperience: null,
    currentRole: null,
    professionalSummary: null,
    companies: [],
    technologies: [],
    education: [],
    resumeSavedAt: null,
    levels: [],
    targetCompanies: [],
    careerNarrative: null,
    excludeResume: false,
    excludeProjects: false,
    excludeStories: false,
    excludeTarget: false,
    resumeUpdatedAt: null,
    targetUpdatedAt: null,
    updatedAt: new Date(0).toISOString(),
    limits: PROFILE_LIMITS,
  };
}

export function toProfileDto(row: UserProfile): ProfileDto {
  return {
    yearsOfExperience: row.yearsOfExperience,
    currentRole: row.currentRole,
    professionalSummary: row.professionalSummary,
    companies: row.companies ?? [],
    technologies: row.technologies ?? [],
    education: row.education ?? [],
    resumeSavedAt: row.resumeSavedAt?.toISOString() ?? null,
    levels: row.levels ?? [],
    targetCompanies: row.targetCompanies ?? [],
    careerNarrative: row.careerNarrative,
    excludeResume: row.excludeResume,
    excludeProjects: row.excludeProjects,
    excludeStories: row.excludeStories,
    excludeTarget: row.excludeTarget,
    resumeUpdatedAt: row.resumeUpdatedAt?.toISOString() ?? null,
    targetUpdatedAt: row.targetUpdatedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    limits: PROFILE_LIMITS,
  };
}

export interface ProjectDto {
  id: string;
  name: string;
  companyContext: string | null;
  timePeriod: string | null;
  scaleDescription: string | null;
  teamSize: string | null;
  myRole: string | null;
  keyDecisions: string | null;
  outcomesWithMetrics: string | null;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export function toProjectDto(row: Project): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    companyContext: row.companyContext,
    timePeriod: row.timePeriod,
    scaleDescription: row.scaleDescription,
    teamSize: row.teamSize,
    myRole: row.myRole,
    keyDecisions: row.keyDecisions,
    outcomesWithMetrics: row.outcomesWithMetrics,
    displayOrder: row.displayOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface StoryDto {
  id: string;
  theme: Story["theme"];
  title: string;
  situation: string | null;
  task: string | null;
  action: string | null;
  result: string | null;
  whatILearned: string | null;
  /**
   * Latest validated bank-side AI suggestion for this story, or
   * null when the user hasn't generated one. Defensively parsed
   * via `suggestedResponseSchema.safeParse` — a corrupted JSONB
   * row hides the affordance on the bank card instead of
   * blowing up the page (same posture as `aiCritique` on
   * `StoryRebuildContextDto`).
   *
   * Distinct from `rebuild.aiSuggestedResponse` (when the story
   * has a backing rebuild): that one was generated against the
   * rebuild's `questionText` (the original interview question);
   * this one was generated against `title` (the saved story's
   * implicit question). Stored on the story row directly so
   * hand-authored stories — which have no rebuild backing — can
   * carry their own suggestion.
   */
  aiSuggestedResponse: SuggestedResponse | null;
  /** ISO-8601 generation stamp; null when no story-side suggestion yet. */
  aiSuggestedResponseGeneratedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toStoryDto(row: Story): StoryDto {
  let aiSuggestedResponse: SuggestedResponse | null = null;
  if (row.aiSuggestedResponseJson != null) {
    const parsed = suggestedResponseSchema.safeParse(
      row.aiSuggestedResponseJson,
    );
    aiSuggestedResponse = parsed.success ? parsed.data : null;
  }
  return {
    id: row.id,
    theme: row.theme,
    title: row.title,
    situation: row.situation,
    task: row.task,
    action: row.action,
    result: row.result,
    whatILearned: row.whatILearned,
    aiSuggestedResponse,
    aiSuggestedResponseGeneratedAt:
      row.aiSuggestedResponseGeneratedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Augmented story DTO — same wire shape as `StoryDto` plus an
 * optional rebuild backlink. The Story Bank page uses this so each
 * card can surface the AI critique + source-session jump for
 * stories that came from a Practice Rebuild.
 *
 * `rebuild` is null when:
 *   - the story was created directly via `/api/stories` (the
 *     candidate filled it out by hand on the profile bank), OR
 *   - the rebuild row was hard-deleted (FK is ON DELETE SET NULL
 *     for `story_rebuilds`, so the story remains).
 *
 * `rebuild.sourceSession` is null even when `rebuild` is set when
 * the originating session was hard-deleted by retention sweep —
 * the rebuild's `source_session_id` FK is also SET NULL.
 */
export interface StoryRebuildContextDto {
  id: string;
  sourceSessionId: string | null;
  sourceImprovementIndex: number | null;
  aiCritique: CritiqueResponse | null;
  /**
   * Latest validated AI-suggested-response payload, or null when
   * the user hasn't generated one. Defensive-parsed the same way
   * as `aiCritique` — a corrupted JSONB row hides the affordance
   * on the bank card instead of blowing up the page.
   */
  aiSuggestedResponse: SuggestedResponse | null;
  /** ISO-8601 generation stamp; null when no suggestion yet. */
  aiSuggestedResponseGeneratedAt: string | null;
  /**
   * Latest critique timestamp = the rebuild row's `updated_at` at
   * the moment of save-to-bank (we don't carry an explicit
   * critique-at column; `updated_at` advances on every PATCH and
   * on save). Good enough for "Critiqued {x} ago" copy.
   */
  updatedAt: string;
  /**
   * Light-weight session header so the card can render
   * "From interview · Stripe coding · 3 days ago" without a
   * second round-trip. Null when `sourceSessionId` is null OR the
   * session row was deleted (hard or soft).
   */
  sourceSession: {
    id: string;
    companyName: string;
    roundType: string;
    createdAt: string;
  } | null;
}

export interface StoryWithRebuildDto extends StoryDto {
  rebuild: StoryRebuildContextDto | null;
}

/**
 * Map the row shape returned by `listStoriesWithRebuilds` into the
 * wire DTO. Defensive parsing same as `toStoryDto` — corrupted
 * JSONB hides the affordance instead of crashing the page.
 *
 * The story-side suggestion (`StoryDto.aiSuggestedResponse`)
 * comes from `toStoryDto` directly. When the story has a backing
 * rebuild, we ALSO carry the rebuild-side suggestion through
 * (`StoryRebuildContextDto.aiSuggestedResponse`) so the bank UI
 * can fall back to it when no story-side suggestion exists yet
 * (the "I generated this from the rebuild flow last week, show
 * me that" preservation case).
 */
export function toStoryWithRebuildDto(args: {
  story: Story;
  rebuild: {
    id: string;
    sourceSessionId: string | null;
    sourceImprovementIndex: number | null;
    aiCritiqueJson: unknown;
    aiSuggestedResponseJson: unknown;
    aiSuggestedResponseGeneratedAt: Date | null;
    updatedAt: Date;
  } | null;
  sourceSession: {
    id: string;
    companyName: string;
    roundType: string;
    createdAt: Date;
  } | null;
}): StoryWithRebuildDto {
  const base = toStoryDto(args.story);
  if (!args.rebuild) {
    return { ...base, rebuild: null };
  }
  let aiCritique: CritiqueResponse | null = null;
  if (args.rebuild.aiCritiqueJson != null) {
    const parsed = critiqueResponseSchema.safeParse(
      args.rebuild.aiCritiqueJson,
    );
    aiCritique = parsed.success ? parsed.data : null;
  }
  let aiSuggestedResponse: SuggestedResponse | null = null;
  if (args.rebuild.aiSuggestedResponseJson != null) {
    const parsed = suggestedResponseSchema.safeParse(
      args.rebuild.aiSuggestedResponseJson,
    );
    aiSuggestedResponse = parsed.success ? parsed.data : null;
  }
  return {
    ...base,
    rebuild: {
      id: args.rebuild.id,
      sourceSessionId: args.rebuild.sourceSessionId,
      sourceImprovementIndex: args.rebuild.sourceImprovementIndex,
      aiCritique,
      aiSuggestedResponse,
      aiSuggestedResponseGeneratedAt:
        args.rebuild.aiSuggestedResponseGeneratedAt?.toISOString() ?? null,
      updatedAt: args.rebuild.updatedAt.toISOString(),
      sourceSession: args.sourceSession
        ? {
            id: args.sourceSession.id,
            companyName: args.sourceSession.companyName,
            roundType: args.sourceSession.roundType,
            createdAt: args.sourceSession.createdAt.toISOString(),
          }
        : null,
    },
  };
}

export interface ResumeParseJobDto {
  id: string;
  status: ResumeParseJob["status"];
  draft: ResumeParseJob["draftJson"];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export function toResumeParseJobDto(row: ResumeParseJob): ResumeParseJobDto {
  return {
    id: row.id,
    status: row.status,
    // Draft is null for pending/processing/failed. We never expose
    // the storage key — it's an internal handle.
    draft: row.status === "completed" ? row.draftJson : null,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}
