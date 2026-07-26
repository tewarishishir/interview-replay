import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";

import { users } from "./users";

/**
 * Per-user profile data that the analyze worker mixes into every
 * interview-feedback prompt. The whole feature is "personalization in
 * one place" — so the design rules are:
 *
 *   1. `user_profiles` is a 1:1 with `users` (PK on `userId`, no
 *      surrogate id). The row is created lazily on first save and
 *      cascade-deletes with the user. Mirrors `user_patterns`.
 *
 *   2. Free-form, list-shaped data (companies, technologies,
 *      education, target levels, target companies) is stored as
 *      JSONB so we can evolve the inner shape without a migration.
 *      Caps live at the API edge (`src/lib/profiles/schemas.ts`)
 *      AND in CHECK constraints below so a buggy write can't
 *      bloat a single row beyond what the LLM prompt budget can
 *      tolerate.
 *
 *   3. Per-section "Exclude from analysis" toggles are explicit
 *      boolean columns rather than a JSONB blob. The analyze
 *      worker reads them on every report build, so a flat column
 *      is faster than parsing JSON, and Postgres can index them
 *      if we ever need to (e.g. "show me users who excluded
 *      everything").
 *
 *   4. Per-section "last updated" is two explicit columns for the
 *      sections that live ON this row (resume + target). Projects
 *      and stories live in their own tables, so their
 *      "last updated" is computed from `MAX(updated_at)` at read
 *      time — no caching column to drift.
 *
 *   5. `resume_parse_jobs` is a separate table because the upload
 *      → parse → review flow is async, the draft must
 *      be readable by the polling endpoint before the user clicks
 *      Save, and we want a clean audit/debug trail per parse
 *      attempt independent of whether the user ever committed it
 *      to `user_profiles`.
 */

/**
 * Levels a candidate is targeting. Stored as JSONB array on the
 * profile row; this is the Zod-mirror used at the API edge.
 *
 * Different from `interviewLevels` (which uses "unsure") because the
 * spec for the profile section explicitly lists "Other".
 */
export const TARGET_LEVELS = [
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "other",
] as const;
export const targetLevelSchema = z.enum(TARGET_LEVELS);
export type TargetLevel = z.infer<typeof targetLevelSchema>;

/**
 * Proficiency tier for a technology entry. Three buckets keeps the
 * dropdown short and reduces the noise the LLM has to weigh.
 */
export const TECH_PROFICIENCIES = [
  "beginner",
  "intermediate",
  "expert",
] as const;
export const techProficiencySchema = z.enum(TECH_PROFICIENCIES);
export type TechProficiency = z.infer<typeof techProficiencySchema>;

export const userProfiles = pgTable(
  "user_profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),

    /* ── Resume section ──────────────────────────────────────── */

    yearsOfExperience: integer("years_of_experience"),
    currentRole: text("current_role"),

    /**
     * 2-4 sentence headline summary extracted from the resume's
     * "Professional Summary" / "Profile" / "Objective" block (or
     * synthesized by the LLM from the first job entry when no
     * dedicated section exists). Used as additional context for
     * the analyze worker.
     *
     * Distinct from `careerNarrative` (which lives on the target
     * section and is the candidate's pitch for the roles they
     * want next). Stored as `text` because the column is a single
     * paragraph, not a list. Capped at the application edge.
     */
    professionalSummary: text("professional_summary"),

    /**
     * `[{ name: string, role: string, time_period: string,
     *     description: string | null }, ...]`
     * Capped at 20 entries by application code AND by the CHECK
     * constraint below.
     */
    companies: jsonb("companies").$type<ProfileCompany[]>(),

    /**
     * `[{ name: string, years_used: number | null,
     *     proficiency: TechProficiency | null }, ...]`
     * Capped at 50 entries.
     */
    technologies: jsonb("technologies").$type<ProfileTechnology[]>(),

    /**
     * `[{ degree: string, institution: string, year: number | null,
     *     field: string | null }, ...]`
     * Capped at 10 entries.
     */
    education: jsonb("education").$type<ProfileEducation[]>(),

    /**
     * Set when the user clicks Save on the resume section, so the
     * UI can show "Resume saved on {date}". Distinct from
     * `resumeUpdatedAt` (last touched ANY resume field) so the
     * "re-upload to refresh" copy reflects the upload event, not
     * a manual field edit.
     */
    resumeSavedAt: timestamp("resume_saved_at", { withTimezone: true }),

    /* ── Target context section ─────────────────────────────── */

    /**
     * `["senior", "staff", ...]` — JSONB array of TargetLevel
     * tokens. Free-text would be friendlier to a future addition,
     * but the spec gates input via checkboxes so a closed enum is
     * the right contract.
     */
    levels: jsonb("levels").$type<TargetLevel[]>(),

    /**
     * `["Stripe", "Anthropic", ...]` — JSONB array of company
     * names from the tag input. We don't gate on the curated
     * suggestion list (a candidate may be targeting any company);
     * length cap below.
     */
    targetCompanies: jsonb("target_companies").$type<string[]>(),

    /**
     * Free text, max 500 words (validated at the API edge). Stored
     * as `text` because the column is a paragraph, not a list.
     */
    careerNarrative: text("career_narrative"),

    /* ── "Exclude from analysis" toggles ─────────────────────── */

    /**
     * One boolean per section (matches the four collapsible
     * sections in the UI). The analyze worker reads these flags
     * on every report build to decide which slabs of profile
     * context to include in the LLM prompt.
     */
    excludeResume: boolean("exclude_resume").notNull().default(false),
    excludeProjects: boolean("exclude_projects").notNull().default(false),
    excludeStories: boolean("exclude_stories").notNull().default(false),
    excludeTarget: boolean("exclude_target").notNull().default(false),

    /* ── Per-section "last updated" timestamps ───────────────── */

    /**
     * Touched whenever ANY field in the resume slab is written
     * (parse-resume save, manual edit, exclude toggle). Distinct
     * from `updatedAt` (which moves on any column change) so the
     * UI can render "Resume last updated 3 days ago" without a
     * JOIN against the audit log.
     */
    resumeUpdatedAt: timestamp("resume_updated_at", { withTimezone: true }),
    targetUpdatedAt: timestamp("target_updated_at", { withTimezone: true }),

    /* ── Bookkeeping ─────────────────────────────────────────── */

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * Defense-in-depth caps. The API-edge Zod schema is the
     * primary guard; these CHECK constraints ensure a buggy
     * write path can't slip a 10MB JSONB through.
     */
    check(
      "user_profiles_yoe_range",
      sql`${table.yearsOfExperience} IS NULL OR (${table.yearsOfExperience} >= 0 AND ${table.yearsOfExperience} <= 60)`,
    ),
    check(
      "user_profiles_companies_max",
      sql`${table.companies} IS NULL OR jsonb_array_length(${table.companies}) <= 20`,
    ),
    check(
      "user_profiles_technologies_max",
      sql`${table.technologies} IS NULL OR jsonb_array_length(${table.technologies}) <= 50`,
    ),
    check(
      "user_profiles_education_max",
      sql`${table.education} IS NULL OR jsonb_array_length(${table.education}) <= 10`,
    ),
    check(
      "user_profiles_levels_max",
      sql`${table.levels} IS NULL OR jsonb_array_length(${table.levels}) <= ${sql.raw(String(TARGET_LEVELS.length))}`,
    ),
    check(
      "user_profiles_target_companies_max",
      sql`${table.targetCompanies} IS NULL OR jsonb_array_length(${table.targetCompanies}) <= 50`,
    ),
  ],
);

/* ────────────────────────────────────────────────────────────── */
/* Projects                                                       */
/* ────────────────────────────────────────────────────────────── */

/**
 * The "3-5 strongest projects" the candidate wants the LLM to weigh.
 * Separate table because:
 *   - Order matters (display_order, drag-and-drop in UI).
 *   - Each row has multiple long text fields that would bloat the
 *     `user_profiles` row and force JSONB validation overhead.
 *   - We want per-row updated_at for the section-level "last
 *     updated" computation.
 *
 * Cap is enforced at the API edge — no DB-side count constraint
 * because Postgres lacks a clean way to express "max N rows per
 * (user_id) without a trigger".
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    companyContext: text("company_context"),
    timePeriod: text("time_period"),
    scaleDescription: text("scale_description"),
    teamSize: text("team_size"),
    myRole: text("my_role"),
    keyDecisions: text("key_decisions"),
    outcomesWithMetrics: text("outcomes_with_metrics"),

    /**
     * 0-based ordering. The reorder endpoint rewrites this column
     * inside a transaction so concurrent reorders can't interleave
     * partial updates.
     */
    displayOrder: integer("display_order").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Listing + reorder: ORDER BY display_order ASC, created_at ASC.
    index("projects_user_order_idx").on(table.userId, table.displayOrder),
    // "Section last updated" is MAX(updated_at) — a small index helps
    // the user_profiles read consolidate without a seq scan.
    index("projects_user_updated_idx").on(table.userId, table.updatedAt.desc()),
  ],
);

/* ────────────────────────────────────────────────────────────── */
/* Behavioral story bank                                          */
/* ────────────────────────────────────────────────────────────── */

/**
 * Pre-defined themes the UI groups stories under. Storing as a
 * Postgres enum gives us hard validation at the driver layer and
 * lets the analyze worker filter to a specific theme in O(log n)
 * via a future index. The `other` value is the catch-all the spec
 * calls out.
 *
 * Snake-case here matches the SQL column convention; the UI maps
 * them to display labels in `src/lib/profiles/themes.ts`.
 */
export const storyTheme = pgEnum("story_theme", [
  "leadership_conflict",
  "biggest_failure",
  "technical_disagreement",
  "ambiguous_problem",
  "mentoring",
  "cross_team_collaboration",
  "deadline_pressure",
  "difficult_colleague",
  "outside_comfort_zone",
  "recovering_from_mistake",
  "other",
]);
export const storyThemeSchema = z.enum(storyTheme.enumValues);
export type StoryTheme = z.infer<typeof storyThemeSchema>;

/**
 * One STAR (situation/task/action/result) story per row, plus the
 * candidate's reflection (`whatILearned`). The product surface
 * shows ONE story per theme by default with a "+" affordance; the
 * data model accepts many per theme (the UI can be extended later
 * without a migration).
 */
export const stories = pgTable(
  "stories",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    theme: storyTheme("theme").notNull(),
    title: text("title").notNull(),
    situation: text("situation"),
    task: text("task"),
    action: text("action"),
    result: text("result"),
    whatILearned: text("what_i_learned"),

    /* ── AI suggested response state (bank-side) ─────────────── */

    /**
     * Latest validated AI-suggested-response payload for this
     * story, generated against the story's title + theme. Shape
     * is `suggestedResponseSchema` from
     * `src/lib/rebuilds/schemas.ts` (shared with the rebuild
     * surface — the JSON shape is the same regardless of which
     * surface generated it). NULL until the user generates one.
     *
     * Distinct from `story_rebuilds.aiSuggestedResponseJson`:
     * the rebuild-side suggestion is generated against the
     * original interview question; this story-side suggestion
     * is generated against the saved story's title. Hand-authored
     * stories only have this column to populate; rebuild-derived
     * stories may have both (the bank UI prefers the story-side
     * value when present).
     */
    aiSuggestedResponseJson: jsonb("ai_suggested_response_json").$type<unknown>(),

    /**
     * Pinned model id (e.g. `"llama3.3:8b"`). Mirrors the rebuild-
     * side column for analytics joins.
     */
    aiSuggestedResponseModelVersion: text(
      "ai_suggested_response_model_version",
    ),

    /**
     * Timestamp of the latest story-side suggestion generation.
     * Drives the bank card's "Generated N minutes ago" copy.
     */
    aiSuggestedResponseGeneratedAt: timestamp(
      "ai_suggested_response_generated_at",
      { withTimezone: true },
    ),

    /**
     * Append-only array of prior suggestion payloads, one entry
     * per generation. Drives the per-story 10-per-24h rate gate.
     * Independent of the rebuild-side gate.
     */
    suggestedResponseHistory: jsonb("suggested_response_history")
      .$type<StorySuggestedResponseHistoryEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // List by theme grouping for the UI; rendered in insertion order.
    index("stories_user_theme_idx").on(
      table.userId,
      table.theme,
      table.createdAt,
    ),
    index("stories_user_updated_idx").on(table.userId, table.updatedAt.desc()),
  ],
);

/**
 * Shape of one entry in `stories.suggested_response_history`.
 * Parallel to `RebuildSuggestedResponseHistoryEntry` from
 * `db/schema/rebuilds.ts`. Kept here (next to `stories`) so the
 * rate gate can import directly without a circular dep.
 */
export interface StorySuggestedResponseHistoryEntry {
  at: string;
  suggestion: unknown;
}

/* ────────────────────────────────────────────────────────────── */
/* Resume parse jobs                                              */
/* ────────────────────────────────────────────────────────────── */

/**
 * Status of an in-flight resume parse:
 *   - pending    : row inserted, upload token minted, frontend
 *                  uploading or worker not yet picked up.
 *   - processing : worker started; PDF being read + LLM call.
 *   - completed  : worker stored a `draftJson`; the polling
 *                  endpoint can now return it for the user to
 *                  review and Save. The stored file has been
 *                  deleted by the worker.
 *   - failed     : worker exhausted retries; `errorMessage`
 *                  populated. The user can re-upload (a new row
 *                  is created — jobs are immutable by design).
 *
 * The 24-hour file cleanup policy means a `pending` row whose
 * client never finished the upload becomes a tombstone after a day;
 * the cleanup is bounded by the fact that we never read these rows
 * after `completedAt + 1h` (a future cron will reap them).
 */
export const resumeParseStatus = pgEnum("resume_parse_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);
export const resumeParseStatusSchema = z.enum(resumeParseStatus.enumValues);
export type ResumeParseStatus = z.infer<typeof resumeParseStatusSchema>;

export const resumeParseJobs = pgTable(
  "resume_parse_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    status: resumeParseStatus("status").notNull().default("pending"),

    /**
     * `resumes/{userId}/{uuid}.pdf`. The worker reads from this
     * key, then deletes the stored file on success or via the
     * 24-hour lifecycle rule on failure/abandonment.
     */
    s3Key: text("s3_key").notNull(),

    /**
     * Parsed structured draft, populated by the worker on success.
     * Shape mirrors `parsedResumeDraftSchema` in
     * `src/lib/profiles/schemas.ts`; stored as JSONB so the
     * polling endpoint can return it untransformed.
     */
    draftJson: jsonb("draft_json").$type<ParsedResumeDraft | null>(),

    /**
     * Captured if the worker gave up after retries. Surfaced by
     * the polling endpoint so the UI can show an actionable
     * message ("we couldn't read this PDF — try a different
     * file or fill the form manually").
     */
    errorMessage: text("error_message"),

    /**
     * Number of LLM call attempts, bumped by the worker. Cap is
     * enforced in code (the worker bails on >2). Useful for
     * cost analysis and to detect a stuck job from the dashboard.
     */
    attempts: integer("attempts").notNull().default(0),

    completedAt: timestamp("completed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Polling endpoint: lookup by id with userId pin.
    uniqueIndex("resume_parse_jobs_id_user_uniq").on(table.id, table.userId),
    index("resume_parse_jobs_user_created_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
    // A future cleanup cron will scan rows past their useful life.
    index("resume_parse_jobs_status_idx").on(table.status, table.updatedAt),
  ],
);

/* ────────────────────────────────────────────────────────────── */
/* JSONB row shapes (re-exported via the barrel)                  */
/* ────────────────────────────────────────────────────────────── */

/**
 * Inline-typed JSONB shapes. Kept as plain interfaces (not Zod
 * schemas) because Drizzle's `$type<…>()` only takes a TS type;
 * the matching Zod validators live in
 * `src/lib/profiles/schemas.ts` and MUST stay in lockstep.
 *
 * Nullability rules:
 *   - Company: `name` is required (drops the row if empty);
 *     `role` and `time_period` are optional so candidates can
 *     keep partial info without being forced to invent dates.
 *   - Education: `degree` and `institution` are individually
 *     optional, but the schema-level refine requires at least
 *     ONE of them to be present (validated in
 *     `profileEducationSchema`).
 */
export interface ProfileCompany {
  name: string;
  role: string | null;
  time_period: string | null;
  /**
   * Free-text description of what the candidate did at this
   * company — bullets / accomplishments / scope. The LLM extracts
   * this from the resume's job-entry body; the user can edit it
   * before saving. Optional on legacy rows that pre-date this
   * field, hence `?` on the property.
   */
  description?: string | null;
}

export interface ProfileTechnology {
  name: string;
  years_used: number | null;
  proficiency: TechProficiency | null;
}

export interface ProfileEducation {
  degree: string | null;
  institution: string | null;
  year: number | null;
  field: string | null;
}

/**
 * Shape of the worker's structured output, mirrored in the LLM
 * prompt + the resume_parse_jobs.draft_json column. Fields are all
 * optional/nullable because the LLM is told to return null for
 * anything it can't infer ("don't invent or assume").
 *
 * `professional_summary` mirrors the new `professional_summary`
 * column on `user_profiles`, and each company in `companies`
 * carries a `description` field (work details / bullets) the
 * user can edit before saving.
 */
export interface ParsedResumeDraft {
  years_of_experience: number | null;
  current_role: string | null;
  professional_summary: string | null;
  companies: ProfileCompany[];
  technologies: ProfileTechnology[];
  education: ProfileEducation[];
}

export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type Story = typeof stories.$inferSelect;
export type NewStory = typeof stories.$inferInsert;

export type ResumeParseJob = typeof resumeParseJobs.$inferSelect;
export type NewResumeParseJob = typeof resumeParseJobs.$inferInsert;
