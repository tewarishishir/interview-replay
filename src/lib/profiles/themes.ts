import type { StoryTheme } from "@/lib/db/schema";

/**
 * Display labels + helper copy for each behavioral story theme.
 *
 * Single source of truth: the API route that returns
 * `/api/stories/themes`, the profile UI's themed groups, and any
 * future analytics labelling all read from this list. Reordering
 * here reorders the UI groups; adding a theme requires a Drizzle
 * enum migration first (Postgres enums can't be appended at the
 * type layer without a migration).
 *
 * Suggested word counts surface as field hints in the story form.
 * 50-200 per STAR field is the spec's target range for a story
 * that's specific enough to be useful but not so long the LLM
 * spends most of its prompt budget on one anecdote.
 */

export interface StoryThemeMeta {
  /** Snake-case enum value, matches `story_theme` Postgres enum. */
  value: StoryTheme;
  /** Title-case display label rendered in the UI. */
  label: string;
  /** Optional one-liner that surfaces under the theme heading. */
  hint: string;
}

export const STORY_THEMES: ReadonlyArray<StoryThemeMeta> = [
  {
    value: "leadership_conflict",
    label: "Leadership conflict",
    hint: "A time you pushed back on a leader, or led through disagreement.",
  },
  {
    value: "biggest_failure",
    label: "Biggest failure",
    hint: "Something you owned, what went wrong, and what you took away.",
  },
  {
    value: "technical_disagreement",
    label: "Technical disagreement",
    hint: "A peer-to-peer technical dispute and how you resolved it.",
  },
  {
    value: "ambiguous_problem",
    label: "Ambiguous problem",
    hint: "A poorly-scoped problem you helped frame from scratch.",
  },
  {
    value: "mentoring",
    label: "Mentoring",
    hint: "Helping someone grow — formally or informally.",
  },
  {
    value: "cross_team_collaboration",
    label: "Cross-team collaboration",
    hint: "Driving alignment across team lines without formal authority.",
  },
  {
    value: "deadline_pressure",
    label: "Deadline pressure",
    hint: "How you handled an immovable deadline that was at risk.",
  },
  {
    value: "difficult_colleague",
    label: "Difficult colleague",
    hint: "Working productively with someone hard to work with.",
  },
  {
    value: "outside_comfort_zone",
    label: "Outside comfort zone",
    hint: "Stretching beyond what you'd done before.",
  },
  {
    value: "recovering_from_mistake",
    label: "Recovering from a mistake",
    hint: "Owning a mistake and the systemic fix you put in place.",
  },
  {
    value: "other",
    label: "Other",
    hint: "Stories that don't fit a standard theme.",
  },
] as const;

/**
 * Per-field word-count targets shown as helper text under each
 * STAR textarea. These are SUGGESTED, not enforced; the API caps
 * at the validation layer with much higher hard limits.
 */
export const STORY_FIELD_WORD_TARGETS = {
  situation: { min: 50, max: 200 },
  task: { min: 50, max: 200 },
  action: { min: 50, max: 200 },
  result: { min: 50, max: 200 },
  what_i_learned: { min: 50, max: 200 },
} as const;
