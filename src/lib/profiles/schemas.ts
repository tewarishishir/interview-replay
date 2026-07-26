import { z } from "zod";

import {
  storyThemeSchema,
  targetLevelSchema,
  techProficiencySchema,
} from "@/lib/db/schema";

import { PROFILE_LIMITS } from "./constants";

/**
 * Zod schemas shared between the `/profile` form, every
 * `/api/profile/*`, `/api/projects/*`, `/api/stories/*`,
 * `/api/profile/parse-resume/*` route, the parse-resume pipeline,
 * and the tests. One module → one source of truth — change a
 * constraint here and the form, API, pipeline, and tests all update
 * in lockstep.
 *
 * Style notes (mirrors `lib/sessions/schemas.ts`):
 *   - `cleanedString` strips control chars + bidi tricks, collapses
 *     whitespace, then enforces a length cap. Use it for any free
 *     text we'll ever surface to the LLM.
 *   - All field-level schemas export both `Input` (form pre-zod)
 *     and `Output` (post-zod) types via `z.input` / `z.output`.
 *   - PATCH-shaped schemas are `.partial()` derivatives so a route
 *     can accept "update one column at a time" without having to
 *     re-send the whole row.
 */

const STRIP_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Non-empty string with a max length cap. Strips garbage chars,
 * collapses internal whitespace, trims.
 */
const cleanedString = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(STRIP_CHARS, "").replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1).max(max));

/**
 * Same as `cleanedString` but allows the cleaned result to be the
 * empty string (the API will store `null` instead). Useful for
 * "the user cleared this optional field" → DB NULL pattern.
 *
 * Accepts either `null` or a string on the wire — clients can
 * send `"field": null` to clear, or `"field": ""` (which we
 * coerce to null), or `"field": "value"`.
 */
const optionalCleaned = (max: number) =>
  z.preprocess(
    (v) => (v == null ? "" : v),
    z
      .string()
      .transform((v) => v.replace(STRIP_CHARS, "").replace(/\s+/g, " ").trim())
      .pipe(z.string().max(max))
      .transform((v): string | null => (v.length === 0 ? null : v)),
  );

/**
 * Multi-line cleaned string. Preserves newlines (we DON'T collapse
 * `\n` into spaces) so STAR-field paragraphs keep their structure
 * for the LLM and for re-display in textareas. Strips control
 * chars (NUL, bidi overrides) and trims surrounding whitespace.
 */
const cleanedParagraph = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(STRIP_CHARS, "").replace(/[ \t]+/g, " ").trim())
    .pipe(z.string().max(max));

/**
 * Optional cleaned paragraph — empty string after cleaning becomes
 * `null` for the DB write. Accepts `null` on the wire.
 */
const optionalCleanedParagraph = (max: number) =>
  z.preprocess(
    (v) => (v == null ? "" : v),
    cleanedParagraph(max).transform((v): string | null =>
      v.length === 0 ? null : v,
    ),
  );

/* ────────────────────────────────────────────────────────────── */
/* JSONB row schemas (mirror the TS interfaces in db/schema)       */
/* ────────────────────────────────────────────────────────────── */

/**
 * `name` is required because it's the row's identity (the form
 * uses an empty `name` as its "this row is blank, drop it" sentinel
 * before submission). `role` and `time_period` are optional —
 * partial info is still useful signal for the LLM, and forcing
 * users to invent a "Senior Engineer" or "2021 — Present" they
 * aren't sure about would push them to make things up.
 *
 * Empty strings on the wire are coerced to `null` by
 * `optionalCleaned`, matching the DB write path.
 */
export const profileCompanySchema = z.object({
  name: cleanedString(200),
  role: optionalCleaned(200),
  time_period: optionalCleaned(100),
  /**
   * Free-text "what I did here" body. Multi-line so the candidate
   * can keep their bullet structure for the LLM to read. Optional
   * because legacy rows (and the form's blank state) start without
   * one.
   */
  description: optionalCleanedParagraph(
    PROFILE_LIMITS.companyDescriptionMax,
  ).optional(),
});
export type ProfileCompanyInput = z.input<typeof profileCompanySchema>;
export type ProfileCompanyOutput = z.output<typeof profileCompanySchema>;

export const profileTechnologySchema = z.object({
  name: cleanedString(100),
  /**
   * Years of experience with the technology. The form's number
   * input may produce empty string ("user cleared the field") so
   * we accept null AND coerce numeric strings.
   */
  years_used: z.preprocess(
    (v) => {
      if (v === "" || v === undefined || v === null) return null;
      return v;
    },
    z.union([
      z.null(),
      z.coerce.number().int().min(0).max(60),
    ]),
  ),
  proficiency: z
    .preprocess(
      (v) => {
        if (v === "" || v === undefined) return null;
        return v;
      },
      z.union([z.null(), techProficiencySchema]),
    )
    .nullable(),
});
export type ProfileTechnologyInput = z.input<typeof profileTechnologySchema>;
export type ProfileTechnologyOutput = z.output<typeof profileTechnologySchema>;

/**
 * The form treats a row as "real" when EITHER `degree` OR
 * `institution` is filled (drops it otherwise). The schema
 * mirrors that: both are individually optional, but the row
 * refuses entries with neither so a stray empty card can't
 * sneak through.
 */
export const profileEducationSchema = z
  .object({
    degree: optionalCleaned(200),
    institution: optionalCleaned(200),
    year: z.preprocess(
    (v) => {
        if (v === "" || v === undefined || v === null) return null;
        return v;
      },
      z.union([
        z.null(),
        // Reasonable bounds: oldest standing university is from the
        // 1080s; future-dating beyond a candidate's graduation year
        // is fine within reason.
        z.coerce.number().int().min(1900).max(2100),
      ]),
    ),
    field: optionalCleaned(200),
  })
  .refine(
    (v) => v.degree != null || v.institution != null,
    "Education entry needs at least a degree or an institution.",
  );
export type ProfileEducationInput = z.input<typeof profileEducationSchema>;
export type ProfileEducationOutput = z.output<typeof profileEducationSchema>;

/* ────────────────────────────────────────────────────────────── */
/* Resume-section payload (PATCH /api/profile body for resume)    */
/* ────────────────────────────────────────────────────────────── */

export const yearsOfExperienceSchema = z.preprocess(
  (v) => {
    if (v === "" || v === undefined || v === null) return null;
    return v;
  },
  z.union([
    z.null(),
    z.coerce
      .number()
      .int()
      .min(PROFILE_LIMITS.yoeMin)
      .max(PROFILE_LIMITS.yoeMax),
  ]),
);

/* ────────────────────────────────────────────────────────────── */
/* Career-narrative — word-count cap                              */
/* ────────────────────────────────────────────────────────────── */

/**
 * Count words by splitting on Unicode whitespace AFTER stripping
 * the bidi/control noise. Empty string → 0. The 500-word ceiling
 * is the spec; we cap at that AND enforce a generous absolute
 * character ceiling so a single 50,000-character "word" can't
 * sneak through.
 */
function countWords(s: string): number {
  const cleaned = s.replace(STRIP_CHARS, "").trim();
  if (cleaned.length === 0) return 0;
  return cleaned.split(/\s+/u).length;
}

export const careerNarrativeSchema = z.preprocess(
  (v) => (v == null ? "" : v),
  z
    .string()
    .transform((v) => v.replace(STRIP_CHARS, "").replace(/[ \t]+/g, " ").trim())
    // Absolute cap: 500 words * ~30 chars/word slack = 15k chars.
    .pipe(z.string().max(15_000))
    .refine(
      (v) => countWords(v) <= PROFILE_LIMITS.careerNarrativeMaxWords,
      `Career narrative must be at most ${PROFILE_LIMITS.careerNarrativeMaxWords} words.`,
    )
    .transform((v): string | null => (v.length === 0 ? null : v)),
);

/* ────────────────────────────────────────────────────────────── */
/* PATCH /api/profile body                                        */
/* ────────────────────────────────────────────────────────────── */

/**
 * Whole-shape PATCH body. EVERY field is optional — the route
 * applies a partial update so the UI can save one section at a
 * time without re-sending the others (and without races where two
 * tabs overwrite each other's progress).
 */
export const profilePatchSchema = z
  .object({
    /* Resume slab */
    yearsOfExperience: yearsOfExperienceSchema.optional(),
    currentRole: optionalCleaned(200).optional(),
    professionalSummary: optionalCleanedParagraph(
      PROFILE_LIMITS.professionalSummaryMax,
    ).optional(),
    companies: z
      .array(profileCompanySchema)
      .max(PROFILE_LIMITS.companiesMax)
      .optional(),
    technologies: z
      .array(profileTechnologySchema)
      .max(PROFILE_LIMITS.technologiesMax)
      .optional(),
    education: z
      .array(profileEducationSchema)
      .max(PROFILE_LIMITS.educationMax)
      .optional(),
    /**
     * Set explicitly when the user clicks Save on the resume
     * section. Either omit (no-op) or pass `true` to stamp now.
     * The API ignores client-supplied timestamps; the value here
     * is a flag, not a date — keeping the wire shape boolean
     * means a client can't backdate the "saved on" badge.
     */
    markResumeSaved: z.boolean().optional(),

    /* Target slab */
    levels: z
      .array(targetLevelSchema)
      .max(6)
      .optional(),
    targetCompanies: z
      .array(cleanedString(200))
      .max(PROFILE_LIMITS.targetCompaniesMax)
      .optional(),
    careerNarrative: careerNarrativeSchema.optional(),
  })
  // Reject fully-empty payloads — that's almost certainly a bug,
  // and 400ing here surfaces it sooner than letting an empty
  // UPDATE run through.
  .refine(
    (v) => Object.keys(v).length > 0,
    "PATCH body must include at least one field.",
  );
export type ProfilePatchInput = z.input<typeof profilePatchSchema>;
export type ProfilePatchOutput = z.output<typeof profilePatchSchema>;

/* ────────────────────────────────────────────────────────────── */
/* PATCH /api/profile/exclude body                                */
/* ────────────────────────────────────────────────────────────── */

export const profileExcludeFieldSchema = z.enum([
  "resume",
  "projects",
  "stories",
  "target",
]);
export type ProfileExcludeField = z.infer<typeof profileExcludeFieldSchema>;

export const profileExcludeBodySchema = z.object({
  field: profileExcludeFieldSchema,
  excluded: z.boolean(),
});
export type ProfileExcludeBody = z.infer<typeof profileExcludeBodySchema>;

/* ────────────────────────────────────────────────────────────── */
/* Projects                                                       */
/* ────────────────────────────────────────────────────────────── */

/**
 * Shared field schema for project create/update. Every text field
 * is optional except `name`; the API translates empty strings to
 * NULLs before write so an "unset" field reads back as `null`
 * rather than `""`.
 */
const projectFields = z.object({
  name: cleanedString(200),
  companyContext: optionalCleaned(200).optional(),
  timePeriod: optionalCleaned(100).optional(),
  scaleDescription: optionalCleanedParagraph(
    PROFILE_LIMITS.projectTextMax,
  ).optional(),
  teamSize: optionalCleaned(100).optional(),
  myRole: optionalCleaned(200).optional(),
  keyDecisions: optionalCleanedParagraph(
    PROFILE_LIMITS.projectTextMax,
  ).optional(),
  outcomesWithMetrics: optionalCleanedParagraph(
    PROFILE_LIMITS.projectTextMax,
  ).optional(),
});

export const projectCreateSchema = projectFields;
export type ProjectCreateInput = z.input<typeof projectCreateSchema>;
export type ProjectCreateOutput = z.output<typeof projectCreateSchema>;

/**
 * For PATCH: every field is optional; absent keys mean "leave
 * alone". `name` is OPTIONAL on PATCH (you might be tweaking only
 * an outcome), but if PRESENT it must still be non-empty.
 */
export const projectPatchSchema = projectFields.partial().refine(
  (v) => Object.keys(v).length > 0,
  "PATCH body must include at least one field.",
);
export type ProjectPatchInput = z.input<typeof projectPatchSchema>;
export type ProjectPatchOutput = z.output<typeof projectPatchSchema>;

export const projectReorderSchema = z.object({
  /**
   * Ordered list of project ids — every project owned by the user
   * must appear exactly once. The handler enforces the
   * "exactly the user's full set" check so a partial list can't
   * silently drop projects from display.
   */
  project_ids_in_order: z
    .array(z.uuid())
    .min(1)
    .max(50)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Duplicate project ids in reorder list.",
    ),
});
export type ProjectReorderInput = z.input<typeof projectReorderSchema>;
export type ProjectReorderOutput = z.output<typeof projectReorderSchema>;

/* ────────────────────────────────────────────────────────────── */
/* Stories                                                        */
/* ────────────────────────────────────────────────────────────── */

const storyFields = z.object({
  theme: storyThemeSchema,
  title: cleanedString(200),
  situation: optionalCleanedParagraph(PROFILE_LIMITS.storyTextMax).optional(),
  task: optionalCleanedParagraph(PROFILE_LIMITS.storyTextMax).optional(),
  action: optionalCleanedParagraph(PROFILE_LIMITS.storyTextMax).optional(),
  result: optionalCleanedParagraph(PROFILE_LIMITS.storyTextMax).optional(),
  whatILearned: optionalCleanedParagraph(
    PROFILE_LIMITS.storyTextMax,
  ).optional(),
});

export const storyCreateSchema = storyFields;
export type StoryCreateInput = z.input<typeof storyCreateSchema>;
export type StoryCreateOutput = z.output<typeof storyCreateSchema>;

export const storyPatchSchema = storyFields.partial().refine(
  (v) => Object.keys(v).length > 0,
  "PATCH body must include at least one field.",
);
export type StoryPatchInput = z.input<typeof storyPatchSchema>;
export type StoryPatchOutput = z.output<typeof storyPatchSchema>;

/* ────────────────────────────────────────────────────────────── */
/* Resume parsing — multipart upload + LLM draft                  */
/* ────────────────────────────────────────────────────────────── */

/**
 * Frontend POSTs `multipart/form-data` to
 * `POST /api/profile/parse-resume`. The route validates the
 * single `file` field against this — Zod by itself can't validate
 * a `File` object so the route does the size + MIME check inline
 * and uses these constants as the source of truth.
 */
export const RESUME_MIME_TYPES = ["application/pdf"] as const;
export const RESUME_MAX_BYTES = PROFILE_LIMITS.resumeMaxBytes;

/**
 * The shape the parse-resume worker stores into
 * `resume_parse_jobs.draft_json` and the polling endpoint returns
 * to the frontend. Mirror of the TypeScript `ParsedResumeDraft`
 * interface in `db/schema/profiles.ts` — keep them in lockstep.
 *
 * Every field is `null`-tolerant because the LLM is told to
 * return null for anything it can't infer ("don't invent or
 * assume"). The frontend pre-fills the editable form with these
 * values — the user is the final arbiter, not the LLM.
 */
export const parsedResumeDraftSchema = z.object({
  years_of_experience: z
    .number()
    .int()
    .min(PROFILE_LIMITS.yoeMin)
    .max(PROFILE_LIMITS.yoeMax)
    .nullable(),
  current_role: cleanedString(200).nullable(),
  /**
   * 2-4 sentence headline pulled from the resume's "Professional
   * Summary" block (or `null` if absent / unclear).
   *
   * Wrapped in `preprocess` because The LLM occasionally emits an
   * empty string for "field not found" instead of `null`; we coerce
   * it to `null` so the persistence layer sees a single sentinel.
   */
  professional_summary: z.preprocess(
    (v) => (typeof v === "string" && v.trim().length === 0 ? null : v),
    cleanedParagraph(PROFILE_LIMITS.professionalSummaryMax).nullable(),
  ),
  companies: z.array(profileCompanySchema).max(PROFILE_LIMITS.companiesMax),
  technologies: z
    .array(profileTechnologySchema)
    .max(PROFILE_LIMITS.technologiesMax),
  education: z.array(profileEducationSchema).max(PROFILE_LIMITS.educationMax),
});
export type ParsedResumeDraftOutput = z.output<typeof parsedResumeDraftSchema>;
