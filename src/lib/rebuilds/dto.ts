import "server-only";

import type {
  RebuildStatus,
  Story,
  StoryRebuild,
} from "@/lib/db/schema";
import { toStoryDto, type StoryDto } from "@/lib/profiles/dto";

import {
  suggestedResponseSchema,
  type CritiqueResponse,
  type SuggestedResponse,
} from "./schemas";

/**
 * DTO mappers for the Practice Rebuild feature. Same posture as
 * `lib/profiles/dto.ts`:
 *
 *   - Convert `Date` columns to ISO-8601 strings so the wire
 *     shape is JSON-clean.
 *   - Coalesce nullable JSONB to `null` consistently.
 *   - Strip nothing today, but the boundary is the right place
 *     to enforce a future "internal-only column" filter.
 */

export interface RebuildDto {
  id: string;
  userId: string;
  sourceSessionId: string | null;
  sourceImprovementIndex: number | null;
  /**
   * Optional artifact (question) the rebuild addresses. Set when
   * the user launches a rebuild from the Analytics tab's per-
   * question card; null otherwise. Stable across re-analyses
   * (unlike `sourceImprovementIndex`).
   */
  sourceArtifactId: string | null;
  /**
   * Optional profile item (project or story) the rebuild Step 3
   * menu should pre-highlight. Same semantics as the column —
   * NULL when no pre-selection was made, and the application is
   * responsible for joining back to the right table.
   */
  preSelectedProfileItemId: string | null;
  questionText: string;
  questionTheme: string | null;
  headline: string | null;
  situation: string | null;
  task: string | null;
  action: string | null;
  result: string | null;
  whatIWouldChange: string | null;
  /** Latest validated critique payload, or null if not yet critiqued. */
  aiCritique: CritiqueResponse | null;
  /**
   * Number of critiques the user has run against this rebuild
   * (including the current one) and how many of those landed in
   * the past 24 hours. The UI uses these to render the "X of 10
   * critiques used today" pill on the critique screen so a user
   * who's about to hit the rate gate can see it coming.
   */
  critiqueRunCount: number;
  critiqueRunsLast24h: number;
  /**
   * Latest validated suggested-response payload, or null if the
   * user hasn't generated one yet. Distinct from `aiCritique` —
   * critique evaluates their draft, suggestion writes one for
   * them to compare against.
   */
  aiSuggestedResponse: SuggestedResponse | null;
  /** ISO-8601 generation stamp; null when no suggestion yet. */
  aiSuggestedResponseGeneratedAt: string | null;
  /**
   * "X of 10 AI drafts used today" — separate counter from
   * `critiqueRunsLast24h` so the UI's two pills don't conflate
   * the two budgets.
   */
  suggestionRunsLast24h: number;
  promotedToStoryId: string | null;
  status: RebuildStatus;
  createdAt: string;
  updatedAt: string;
}

export function toRebuildDto(row: StoryRebuild): RebuildDto {
  // history.length includes only PRIOR critiques (the current one
  // is on `aiCritiqueJson`). Total runs = history.length + (1 if
  // current present else 0). The 24h count is computed from the
  // history timestamps PLUS the current critique's `updatedAt`
  // when present (we don't carry a separate timestamp on the
  // current critique, but `updatedAt` is the moment we wrote it).
  const history = Array.isArray(row.critiqueHistory)
    ? row.critiqueHistory
    : [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let runsLast24h = 0;
  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    const at = (entry as { at?: unknown }).at;
    if (typeof at !== "string") continue;
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= cutoff) runsLast24h++;
  }
  if (row.aiCritiqueJson != null) {
    if (row.updatedAt.getTime() >= cutoff) runsLast24h++;
  }
  const totalRuns = history.length + (row.aiCritiqueJson != null ? 1 : 0);

  // Suggestion 24h counter — same shape, but reads the
  // dedicated `aiSuggestedResponseGeneratedAt` column for the
  // current entry (since `updatedAt` advances on every PATCH and
  // can't double as the suggestion's freshness stamp).
  const suggestionHistory = Array.isArray(row.suggestedResponseHistory)
    ? row.suggestedResponseHistory
    : [];
  let suggestionRunsLast24h = 0;
  for (const entry of suggestionHistory) {
    if (!entry || typeof entry !== "object") continue;
    const at = (entry as { at?: unknown }).at;
    if (typeof at !== "string") continue;
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= cutoff) suggestionRunsLast24h++;
  }
  if (
    row.aiSuggestedResponseJson != null &&
    row.aiSuggestedResponseGeneratedAt != null &&
    row.aiSuggestedResponseGeneratedAt.getTime() >= cutoff
  ) {
    suggestionRunsLast24h++;
  }

  // Defensive parse of the suggestion JSONB. Same posture as the
  // bank-page DTO: a corrupted row should hide the affordance,
  // not crash the page.
  let aiSuggestedResponse: SuggestedResponse | null = null;
  if (row.aiSuggestedResponseJson != null) {
    const parsed = suggestedResponseSchema.safeParse(
      row.aiSuggestedResponseJson,
    );
    aiSuggestedResponse = parsed.success ? parsed.data : null;
  }

  return {
    id: row.id,
    userId: row.userId,
    sourceSessionId: row.sourceSessionId,
    sourceImprovementIndex: row.sourceImprovementIndex,
    sourceArtifactId: row.sourceArtifactId,
    preSelectedProfileItemId: row.preSelectedProfileItemId,
    questionText: row.questionText,
    questionTheme: row.questionTheme,
    headline: row.headline,
    situation: row.situation,
    task: row.task,
    action: row.action,
    result: row.result,
    whatIWouldChange: row.whatIWouldChange,
    aiCritique: (row.aiCritiqueJson as CritiqueResponse | null) ?? null,
    critiqueRunCount: totalRuns,
    critiqueRunsLast24h: runsLast24h,
    aiSuggestedResponse,
    aiSuggestedResponseGeneratedAt:
      row.aiSuggestedResponseGeneratedAt?.toISOString() ?? null,
    suggestionRunsLast24h,
    promotedToStoryId: row.promotedToStoryId,
    status: row.status as RebuildStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Re-export the story DTO type so callers can import everything
 * the save-to-bank response needs from one place.
 */
export type { StoryDto };
export { toStoryDto };

/**
 * Save-to-bank response wire shape — story + rebuild together so
 * the client can render the "saved" step without a follow-up
 * round-trip to refetch the rebuild row.
 */
export interface SavedToBankDto {
  story: StoryDto;
  rebuild: RebuildDto;
}

export function toSavedToBankDto(args: {
  story: Story;
  rebuild: StoryRebuild;
}): SavedToBankDto {
  return {
    story: toStoryDto(args.story),
    rebuild: toRebuildDto(args.rebuild),
  };
}
