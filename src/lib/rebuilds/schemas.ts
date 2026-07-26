import { z } from "zod";

import {
  rebuildQuestionThemeSchema,
  rebuildStatusSchema,
  storyThemeSchema,
} from "@/lib/db/schema";

/**
 * API edge schemas + the LLM critique response shape.
 *
 * The body schemas are deliberately tighter than the DB caps so a
 * stuck client (auto-save loop, paste-of-novel-into-textarea) can't
 * pile a 1MB blob into the DB even though the column is `text`. The
 * caps come from the spec:
 *
 *   - question_text     1000 chars
 *   - STAR fields       2000 chars each
 *
 * The critique-response schema mirrors the prompt-required JSON shape
 * exactly — it is the validator the LLM client retries against once
 * before bubbling a graceful error to the client.
 */

const TEXT_FIELD_MAX = 2000;
const QUESTION_TEXT_MAX = 1000;

/* ────────────────────────────────────────────────────────────── */
/* POST /api/rebuilds                                             */
/* ────────────────────────────────────────────────────────────── */

export const createRebuildBodySchema = z
  .object({
    source_session_id: z.uuid().optional(),
    /**
     * Index into the source session's `report.improvements[]`.
     * Bounded `[0, 10]` because the report cap on improvements is
     * 6; the cushion lets a future rubric expansion not break
     * existing rebuilds.
     */
    source_improvement_index: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional(),
    /**
     * Optional question-artifact pin. Set when the user launches a
     * rebuild from the Analytics tab's per-question card. The
     * route handler verifies that the UUID belongs to an artifact
     * on a session the user owns; cross-tenant attempts read back
     * as a 404 with no info disclosure.
     */
    source_artifact_id: z.uuid().optional(),
    /**
     * Optional profile item (project or story) to pre-select on
     * the rebuild's Step 3 menu. Validated server-side against
     * the user's `projects` / `stories` so a malicious or stale
     * client can't pin a UUID it doesn't own — see the create
     * route for the lookup. Not a Postgres FK constraint because
     * it points at one of two tables.
     */
    pre_selected_profile_item_id: z.uuid().optional(),
    question_text: z
      .string()
      .trim()
      .min(1, "Tell us what question you're answering.")
      .max(QUESTION_TEXT_MAX, "Question is too long."),
    question_theme: rebuildQuestionThemeSchema.optional(),
  })
  /**
   * `source_improvement_index` is meaningless without a session
   * pin, and a stuck client could submit one without the other
   * after a partial form fill. Reject the half-state at the
   * edge.
   */
  .refine(
    (v) =>
      v.source_improvement_index === undefined || v.source_session_id !== undefined,
    {
      message:
        "source_improvement_index requires source_session_id to be set.",
      path: ["source_improvement_index"],
    },
  );

export type CreateRebuildInput = z.infer<typeof createRebuildBodySchema>;

/* ────────────────────────────────────────────────────────────── */
/* PATCH /api/rebuilds/:id                                        */
/* ────────────────────────────────────────────────────────────── */

const optionalDraftField = z
  .union([
    z.string().max(TEXT_FIELD_MAX, "Field is too long."),
    z.null(),
  ])
  .optional();

/**
 * Partial update. Every field is optional; the API rejects an
 * empty body up at the route boundary the same way the outcome
 * route does. `null` is allowed for explicit clearing (the user
 * empties a textarea and the auto-save sends a clear).
 *
 * `question_theme` can also be PATCHed if the user's understanding
 * of the question changes mid-rebuild. `question_text` is set on
 * create only; renaming the question after the fact is a different
 * rebuild conceptually.
 */
export const patchRebuildBodySchema = z.object({
  headline: optionalDraftField,
  situation: optionalDraftField,
  task: optionalDraftField,
  action: optionalDraftField,
  result: optionalDraftField,
  what_i_would_change: optionalDraftField,
  question_theme: rebuildQuestionThemeSchema.nullable().optional(),
});

export type PatchRebuildInput = z.infer<typeof patchRebuildBodySchema>;

/* ────────────────────────────────────────────────────────────── */
/* GET /api/rebuilds                                              */
/* ────────────────────────────────────────────────────────────── */

export const listRebuildsQuerySchema = z.object({
  status: rebuildStatusSchema.optional(),
  session_id: z.uuid().optional(),
  /**
   * Page size. Bounded so a stuck client can't ask for the entire
   * table. Default of 50 matches the dashboard's session list.
   */
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type ListRebuildsQuery = z.infer<typeof listRebuildsQuerySchema>;

/* ────────────────────────────────────────────────────────────── */
/* POST /api/rebuilds/:id/save-to-bank                            */
/* ────────────────────────────────────────────────────────────── */

/**
 * Body for the save-to-bank promotion. The chosen `theme`, when
 * present, is the authoritative theme the saved `stories` row
 * will carry. When omitted (the scaffold-step "Save without
 * critique" shortcut), the server falls back to
 * `mapRebuildThemeToStoryTheme(rebuild.questionTheme)` — which
 * itself defaults to `"other"` when the question theme is null
 * or unrecognized.
 *
 * History (kept so the next reviewer doesn't re-debate this):
 *   - Originally REQUIRED. The report-launch path of `RebuildLauncher`
 *     never sets `question_theme`, so server-side fallback was
 *     dropping every saved rebuild into "Other" with no user
 *     control. Forcing the user to pick at save-time fixed that.
 *   - Now OPTIONAL again because users want a "save the AI draft
 *     directly without paying for critique" shortcut from the
 *     scaffold step. We accept the "Other" risk for that path
 *     specifically (the user can re-bucket from the story bank
 *     immediately). The critique-step save flow STILL passes a
 *     theme explicitly so the dedicated `<Select>` continues to
 *     gate the bucketing.
 *
 * The chosen (or fallback) theme is written back to
 * `story_rebuilds.questionTheme` inside the same transaction so
 * the audit row reflects the final categorization.
 */
export const saveToBankBodySchema = z.object({
  theme: storyThemeSchema.optional(),
});

export type SaveToBankInput = z.infer<typeof saveToBankBodySchema>;

/* ────────────────────────────────────────────────────────────── */
/* Critique response — the JSON the LLM must produce              */
/* ────────────────────────────────────────────────────────────── */

/**
 * The seven dimensions the critique evaluates. Order here is the
 * order the system prompt enforces. `behavioral_change` is only
 * emitted for failure-shaped themes (see `FAILURE_THEMES` in
 * schema/rebuilds.ts).
 */
export const CRITIQUE_DIMENSIONS = [
  "headline",
  "star_completeness",
  "first_person",
  "quantification",
  "behavioral_change",
  "profile_consistency",
  "profile_leverage",
] as const;
export const critiqueDimensionSchema = z.enum(CRITIQUE_DIMENSIONS);
export type CritiqueDimension = z.infer<typeof critiqueDimensionSchema>;

export const CRITIQUE_STATUSES = [
  "strong",
  "needs_work",
  "missing",
  "discrepancy",
] as const;
export const critiqueStatusSchema = z.enum(CRITIQUE_STATUSES);
export type CritiqueStatus = z.infer<typeof critiqueStatusSchema>;

/**
 * Profile reference attached to a dimension when the critique
 * cites the candidate's profile. The `field_path` is human-
 * readable (`user_projects[id=abc].outcomes_with_metrics`,
 * `stories[id=xyz].result`) — the renderer parses it cosmetically
 * but the truth is `field_value`, which is asserted verbatim in
 * the source profile by guardrail 2.
 */
export const profileReferenceSchema = z.object({
  field_path: z.string().min(1).max(500),
  field_value: z.string().min(1).max(5000),
});
export type ProfileReference = z.infer<typeof profileReferenceSchema>;

/**
 * Lenient wrapper around `profileReferenceSchema.optional()` for
 * use as a field validator. Haiku frequently violates the prompt's
 * "omit the key when there's nothing to cite" instruction in three
 * subtly different ways:
 *
 *   1. `profile_reference: null` — whole field nulled.
 *   2. `profile_reference: {}` — empty object.
 *   3. `profile_reference: { field_path: null, field_value: null }` —
 *      object with both inner fields nulled.
 *   4. `profile_reference: { field_path: "", field_value: "" }` —
 *      object with both inner fields blanked.
 *
 * Plain `.optional()` rejects all four and trips a schema-validation
 * failure on EVERY non-citing dimension at once, which the runner
 * then catches into the synthetic "we had trouble" fallback critique.
 *
 * Treat any of the four as "absent" (coerce to `undefined`) so the
 * `.optional()` branch matches and the rest of the dimension
 * passes through cleanly.
 *
 * Half-formed references (one inner field set, the other not) are
 * still rejected by `profileReferenceSchema`'s `.min(1)` — that's a
 * real model error that the retry loop can try to fix. We only
 * coerce when BOTH inner fields are absent, which is the empirical
 * "non-citing dimension" shape.
 *
 * Confirmed via the new `[rebuild-critique] schema_validation_failed`
 * logs (added in the same PR as this fix): pre-fix logs showed every
 * one of 7 dimensions failing with
 * `dimension_feedback.N.profile_reference.field_path: Invalid input`
 * on both initial + retry attempts.
 */
const lenientProfileReferenceField = z.preprocess(
  (v) => {
    if (v == null) return undefined;
    if (typeof v !== "object") return undefined;
    const obj = v as { field_path?: unknown; field_value?: unknown };
    const pathStr =
      typeof obj.field_path === "string" ? obj.field_path.trim() : "";
    const valueStr =
      typeof obj.field_value === "string" ? obj.field_value.trim() : "";
    if (pathStr === "" && valueStr === "") return undefined;
    return v;
  },
  profileReferenceSchema.optional(),
);

/**
 * Lenient wrapper for `quoted_excerpt`. Models occasionally emit
 * `null` instead of an empty string when there's nothing to
 * quote (status='strong' or status='missing'); coerce to "".
 * Trims the value if it overflows the 2000-char cap rather than
 * failing the whole response — a slightly truncated quote is
 * better UX than a generic critique-failed banner.
 */
const lenientQuotedExcerpt = z.preprocess(
  (v) => {
    if (v == null) return "";
    if (typeof v !== "string") return "";
    if (v.length > 2000) return v.slice(0, 2000);
    return v;
  },
  z.string().max(2000),
);

/**
 * Lenient wrapper for `what_to_check`. The schema requires a
 * non-empty string; the model sometimes returns `null` or "" for
 * `status='strong'` dimensions. Substituting a benign placeholder
 * keeps the response valid (the renderer just shows the dimension
 * label with the affirmation).
 */
const lenientWhatToCheck = z.preprocess(
  (v) => {
    if (v == null || v === "") return "Re-read this section.";
    if (typeof v === "string" && v.length > 2000) return v.slice(0, 2000);
    return v;
  },
  z.string().min(1).max(2000),
);

export const dimensionFeedbackSchema = z.object({
  dimension: critiqueDimensionSchema,
  status: critiqueStatusSchema,
  /**
   * Verbatim excerpt from the candidate's draft. May be empty
   * when `status === 'missing'` (nothing to quote) or
   * `status === 'strong'` (nothing to flag).
   */
  quoted_excerpt: lenientQuotedExcerpt,
  profile_reference: lenientProfileReferenceField,
  what_to_check: lenientWhatToCheck,
});
export type DimensionFeedback = z.infer<typeof dimensionFeedbackSchema>;

/**
 * Full validated critique response. The system prompt requires the
 * model to always return all 7 dimensions when failure-shaped, or
 * 6 when not (skipping `behavioral_change`); we accept 5-10 here so
 * a model that genuinely can't grade one dimension on a thin draft
 * doesn't trip a hard schema error before our guardrails even run,
 * and so a model that emits an extra well-meaning category
 * (occasional Haiku drift) still validates — guardrails will run
 * across whatever dimensions came back.
 *
 * Length caps on the prose fields are intentionally generous
 * (2000 / 1000) compared to the original 1000 / 500. The tighter
 * caps were tripping the schema validator on otherwise-fine
 * critiques where Haiku was a little chatty, and the user-facing
 * cost of a critique-failed banner is much higher than the cost
 * of an extra 500 chars in the JSON we store.
 */
/**
 * Truncate-only preprocess. We never coerce null/empty here — a
 * missing `overall_assessment` or `next_step_suggestion` is a
 * real critique failure that the user should retry, not silently
 * paper over. This wrapper only catches the chatty-model case
 * where the prose runs over the cap by a few hundred chars.
 */
const truncatingString = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.length > max ? v.slice(0, max) : v),
    z.string().min(1).max(max),
  );

export const critiqueResponseSchema = z.object({
  overall_assessment: truncatingString(2000),
  dimension_feedback: z.array(dimensionFeedbackSchema).min(5).max(10),
  next_step_suggestion: truncatingString(1000),
});
export type CritiqueResponse = z.infer<typeof critiqueResponseSchema>;

/* ────────────────────────────────────────────────────────────── */
/* Suggested-response — the JSON the LLM must produce for the     */
/* "Generate AI draft" feature.                                   */
/* ────────────────────────────────────────────────────────────── */

/**
 * One source citation attached to the suggestion. The runner's
 * verbatim guardrail asserts every `field_value` here actually
 * appears (whitespace-normalized) in the rendered profile context
 * — anything that doesn't is the model hallucinating evidence and
 * trips the same fallback path the critique guardrail uses.
 *
 * `field_path` is the human-readable identifier the renderer uses
 * to show "drawn from project X / story Y". The runner doesn't
 * parse it semantically; truth is `field_value`.
 */
export const suggestionSourceSchema = z.object({
  field_path: z.string().min(1).max(500),
  field_value: z.string().min(1).max(5000),
});
export type SuggestionSource = z.infer<typeof suggestionSourceSchema>;

/**
 * Lenient wrapper for the optional `whatIWouldChange` (failure
 * themes only). Coerces `null` / empty to `null` so the renderer
 * can branch cleanly without juggling `undefined`.
 */
const optionalNullableString = (max: number) =>
  z.preprocess(
    (v) => {
      if (v == null) return null;
      if (typeof v !== "string") return null;
      const t = v.trim();
      if (t.length === 0) return null;
      if (t.length > max) return t.slice(0, max);
      return v;
    },
    z.union([z.string().min(1).max(max), z.null()]),
  );

/**
 * Lenient wrapper for the `caveats` array. The model sometimes
 * emits `null` instead of `[]`; coerce so an honest "I had nothing
 * to caveat" answer doesn't trip the validator.
 */
const lenientCaveatsArray = z.preprocess(
  (v) => {
    if (v == null) return [];
    if (!Array.isArray(v)) return [];
    return v
      .filter((entry): entry is string => typeof entry === "string")
      .map((s) => (s.length > 500 ? s.slice(0, 500) : s));
  },
  z.array(z.string().min(1).max(500)).max(20),
);

/**
 * Validated AI suggested-response payload. The shape mirrors the
 * STAR scaffold the user fills in themselves, with two extra
 * fields:
 *
 *   - `sources`: the profile-fact citations the model used to
 *     compose the draft. Each `field_value` is verified verbatim
 *     against the rendered profile context block by the runner's
 *     guardrail; a hallucinated citation falls back to a synthetic
 *     suggestion the same way the critique guardrail does.
 *
 *   - `caveats`: short notes the model can attach when it had to
 *     leave something as a placeholder ("no metric available for
 *     X") — surfaced beside the draft so the user knows what to
 *     fill in themselves.
 *
 * `whatIWouldChange` is only required for failure themes; the
 * runner sets it to `null` for non-failure themes before
 * persistence, so the schema accepts `null | string`.
 */
export const suggestedResponseSchema = z.object({
  headline: truncatingString(200),
  situation: truncatingString(TEXT_FIELD_MAX),
  task: truncatingString(TEXT_FIELD_MAX),
  action: truncatingString(TEXT_FIELD_MAX),
  result: truncatingString(TEXT_FIELD_MAX),
  whatIWouldChange: optionalNullableString(TEXT_FIELD_MAX),
  sources: z.array(suggestionSourceSchema).max(20),
  caveats: lenientCaveatsArray,
});
export type SuggestedResponse = z.infer<typeof suggestedResponseSchema>;
