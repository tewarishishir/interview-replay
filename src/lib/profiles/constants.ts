import type { TargetLevel } from "@/lib/db/schema";

/**
 * Display labels for the collapsible sections on `/profile`.
 *
 * The `stories` section was extracted to a top-level page at
 * `/stories` so saved Practice Rebuild outputs (with attached AI
 * critique + source-session backlink) get first-class
 * navigation; the `excludeStories` flag still lives on
 * `user_profiles` and gates the analyze prompt, but its toggle UI
 * has moved to the new page.
 */
export type ProfileSectionKey = "resume" | "projects" | "target";

export const PROFILE_SECTIONS: ReadonlyArray<{
  key: ProfileSectionKey;
  title: string;
  description: string;
}> = [
  {
    key: "resume",
    title: "Resume import",
    description:
      "Upload a PDF or fill it in manually. We extract the structure for you to confirm.",
  },
  {
    key: "projects",
    title: "Projects",
    description:
      "Your 3–5 strongest projects, in priority order. Drag to reorder.",
  },
  {
    key: "target",
    title: "Target context",
    description:
      "Levels, companies, and the narrative you're using when you apply.",
  },
] as const;

/**
 * Display labels for `TARGET_LEVELS` (the schema's enum values are
 * snake-case for SQL stability; the UI shows title-case).
 */
export const TARGET_LEVEL_OPTIONS: ReadonlyArray<{
  value: TargetLevel;
  label: string;
}> = [
  { value: "junior", label: "Junior" },
  { value: "mid", label: "Mid" },
  { value: "senior", label: "Senior" },
  { value: "staff", label: "Staff" },
  { value: "principal", label: "Principal" },
  { value: "other", label: "Other" },
] as const;

export const TECH_PROFICIENCY_OPTIONS = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "expert", label: "Expert" },
] as const;

/**
 * Hard product limits surfaced in the UI as character / word
 * counters. Mirrored exactly by the Zod schemas in
 * `./schemas.ts` and (where possible) by Postgres CHECK
 * constraints.
 */
export const PROFILE_LIMITS = {
  resumeMaxBytes: 5 * 1024 * 1024, // 5 MB
  yoeMin: 0,
  yoeMax: 60,
  companiesMax: 20,
  technologiesMax: 50,
  educationMax: 10,
  targetCompaniesMax: 50,
  careerNarrativeMaxWords: 500,
  /**
   * Length cap for the resume "Professional Summary" textarea +
   * the LLM's parsed `professional_summary` field. ~1500 chars is
   * roughly 250 words — generous for the 2-4 sentence headline the
   * UI suggests, with slack for verbose drafts.
   */
  professionalSummaryMax: 1500,
  /**
   * Length cap for each company's "what I did here" description
   * (work details). Two short paragraphs of bullets.
   */
  companyDescriptionMax: 2000,
  /**
   * The product surface caps "strongest projects" at 5 — a
   * candidate showing 8 is signaling none of them are strongest.
   * The DB has no row-count constraint (Postgres can't easily
   * express "max N rows per FK"); the API returns 409 when this
   * is hit.
   */
  projectsMax: 5,
  /**
   * Recommendation: the dashboard nudge fires when fewer than
   * this number of projects are saved.
   */
  projectsRecommendedMin: 3,
  /**
   * Per-field length caps for project text fields. Generous
   * enough to hold a meaty paragraph; tight enough to keep the
   * total LLM prompt body bounded.
   */
  projectTextMax: 2000,
  /**
   * STAR-field length cap per story field. 5000 chars ≈ 800-1000
   * words, which accommodates the spec's 50-200 SUGGESTION while
   * tolerating outliers without rejecting at the API edge.
   */
  storyTextMax: 5000,
  /**
   * Per-user story cap. The product surface lists 11 themes (10
   * predefined + "other"); allowing a few stories per theme covers
   * candidates who want variants for different types of role
   * without letting a runaway client loop bloat the analyze prompt
   * (every non-excluded story is included in every report build).
   */
  storiesMax: 30,
} as const;
