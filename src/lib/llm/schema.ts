import { z } from "zod";

/**
 * The shape of an InterviewReplay feedback report — the structured JSON we
 * ask the LLM to produce, validate against this schema before
 * persisting, and render on the report page.
 *
 * Hierarchy mirrors the report-page layout:
 *   - Executive summary (large + prominent)
 *   - Strengths (list with quotes)
 *   - Improvements (list with concrete actions)
 *   - Communication signals (4 sub-sections)
 *   - Round-specific section (varies by round_type)
 *   - "InterviewReplay'ed read" — the boxed, emphasized one-paragraph take
 *
 * Round-specific is a discriminated union keyed on `kind`, but we
 * keep validation lenient (`z.object({ ... }).passthrough()`) on
 * the round-specific block so a model that adds an extra field
 * doesn't fail validation; we only require the load-bearing
 * fields per round type.
 */

const quoteEvidence = z.object({
  quote: z.string().min(1),
  /**
   * Optional approximate timestamp in seconds from the start of
   * the recording. The model may not always populate this; the
   * UI just hides it when absent.
   */
  approxTimestampSeconds: z.number().nonnegative().optional(),
});

export const strengthSchema = z.object({
  heading: z.string().min(1),
  detail: z.string().min(1),
  evidence: z.array(quoteEvidence).min(0).max(5).default([]),
});
export type Strength = z.infer<typeof strengthSchema>;

export const improvementSchema = z.object({
  heading: z.string().min(1),
  detail: z.string().min(1),
  /**
   * One concrete action the candidate can take in their next
   * interview. The system prompt requires this be specific and
   * actionable (not "be more confident").
   */
  action: z.string().min(1),
  evidence: z.array(quoteEvidence).min(0).max(5).default([]),
  /**
   * Whether THIS improvement should surface a "Rebuild a story for
   * this →" inline button in the report. The model decides per
   * improvement during analysis using the criteria the system
   * prompt spells out:
   *
   *   true  — improvements about a structural gap in a story
   *           (missing result, deflected ownership, weak STAR,
   *           "we" overuse, missing behavioral change in failure
   *           stories) that genuinely benefit from a structured
   *           rewrite-and-critique loop.
   *   false — improvements about pacing, filler words, communication
   *           delivery, or pre-interview research. Those are
   *           rehearsal problems, not rewrite problems.
   *
   * Defaults to `false` so legacy reports persisted before the
   * field was introduced still validate (Option A: no backfill,
   * old reports just don't surface the button — the dashboard
   * explanation in `report-view.tsx`'s migration note has the
   * full rationale).
   */
  rebuildEligible: z.boolean().default(false),
});
export type Improvement = z.infer<typeof improvementSchema>;

export const communicationSignalsSchema = z.object({
  pace: z.object({
    summary: z.string().min(1),
    averageWordsPerMinute: z.number().nonnegative().optional(),
  }),
  fillerWords: z.object({
    summary: z.string().min(1),
    topOffenders: z.array(z.string()).max(8).default([]),
    countTotal: z.number().nonnegative().optional(),
  }),
  structure: z.object({
    summary: z.string().min(1),
  }),
  presence: z.object({
    summary: z.string().min(1),
  }),
});
export type CommunicationSignals = z.infer<typeof communicationSignalsSchema>;

const roundSpecificCoding = z.object({
  kind: z.literal("coding"),
  problemFraming: z.string().min(1),
  solutionExploration: z.string().min(1),
  implementationHygiene: z.string().min(1),
  verification: z.string().min(1),
  recoveryFromFeedback: z.string().min(1),
});

const roundSpecificSystemDesign = z.object({
  kind: z.literal("system_design"),
  requirementsGathering: z.string().min(1),
  highLevelDesign: z.string().min(1),
  deepDives: z.string().min(1),
  tradeOffsAndFailureModes: z.string().min(1),
  scalingStory: z.string().min(1),
});

/**
 * Behavioral story-highlight classification. Used by the report
 * UI to surface a small label badge above each story so the user
 * can scan to "the strongest" / "the failure story" / etc. at a
 * glance instead of reading every critique.
 *
 *   - `strongest_story`      — the single best STAR loop in the round,
 *                              shown with a green badge.
 *   - `needs_work`           — a story whose STAR landing was the
 *                              weakest (missing result, vague action,
 *                              weak conclusion). Amber badge.
 *   - `failure_or_difficult` — a "tell me about a failure / hardest
 *                              moment" story, regardless of how well
 *                              it landed. Coral badge.
 *   - `needs_landing`      — good substance but ended without a clear result.
 *   - `most_proud_of`      — only when the "most proud of" question was asked.
 */
export const storyHighlightCategorySchema = z.enum([
  "strongest_story",
  "most_proud_of",
  "failure_or_difficult",
  "needs_landing",
]);
export type StoryHighlightCategory = z.infer<typeof storyHighlightCategorySchema>;

export const storyHighlightSchema = z.object({
  category: storyHighlightCategorySchema,
  title: z.string().min(10).max(120),
  body: z.string().min(50).max(800),
});
export type StoryHighlight = z.infer<typeof storyHighlightSchema>;

const roundSpecificBehavioral = z.object({
  kind: z.literal("behavioral"),
  starCompleteness: z.string().min(1),
  specificity: z.string().min(1),
  selfAwareness: z.string().min(1),
  leadershipSignals: z.string().min(1),
});

const roundSpecificOther = z.object({
  kind: z.literal("other"),
  understanding: z.string().min(1),
  structure: z.string().min(1),
  reasoning: z.string().min(1),
  engagement: z.string().min(1),
});

export const roundSpecificSchema = z.discriminatedUnion("kind", [
  roundSpecificCoding,
  roundSpecificSystemDesign,
  roundSpecificBehavioral,
  roundSpecificOther,
]);
export type RoundSpecific = z.infer<typeof roundSpecificSchema>;

/**
 * The "InterviewReplay'ed read" — a single boxed paragraph the candidate
 * reads first. Speak in the second person, blunt but supportive,
 * and DO NOT include any pass/fail framing.
 *
 * `readinessScore` is a 0-100 measure of HOW PREPARED the
 * candidate looked in this round at their stated level. It is
 * NOT a hire/no-hire prediction (the prompt's hard rules and
 * `forbidden.ts` regex still apply). Optional in the schema so
 * legacy reports persisted before the field was introduced
 * still validate; new reports always populate it. Render-side
 * derives the tier label and color so the rubric stays consistent
 * across reports.
 */
export const aiReadSchema = z.object({
  paragraph: z.string().min(1).max(1500),
  readinessScore: z.number().int().min(0).max(100).optional(),
});

/**
 * One question the model identified as having been asked during
 * the round. Sonnet populates this list as part of the report so
 * the candidate sees an authoritative "questions covered" view
 * even when the upstream Haiku review-screen pass returned zero
 * suggestions (Haiku occasionally fails to produce items on
 * heavily-redacted, very-long, or otherwise noisy transcripts —
 * Sonnet has the full transcript + the candidate-supplied
 * artifacts and can backfill the list reliably).
 *
 * Fields:
 *   - `question`      The question text, normalized to interviewer
 *                     phrasing (not a paraphrase of the answer).
 *   - `confidence`    'high'   — directly stated or unmistakable
 *                                from the candidate's wording.
 *                     'medium' — plausible best-guess.
 *                     'low'    — a weak guess the candidate should
 *                                judge themselves.
 *   - `source`        'candidate_confirmed' — pulled from a
 *                       candidate-confirmed artifact (or one the
 *                       candidate added by hand).
 *                     'transcript_inferred' — Sonnet inferred this
 *                       from the transcript itself; the candidate
 *                       never confirmed it.
 *   - `evidenceQuote` Optional verbatim snippet from the candidate's
 *                     answer that anchors the inference. Trimmed to
 *                     500 chars to keep the report compact.
 */
export const questionCoveredSchema = z.object({
  question: z.string().min(1).max(500),
  confidence: z.enum(["high", "medium", "low"]),
  source: z.enum(["candidate_confirmed", "transcript_inferred"]),
  evidenceQuote: z.string().min(1).max(500).optional(),
});
export type QuestionCovered = z.infer<typeof questionCoveredSchema>;

/**
 * Per-question analytics — the structured per-answer breakdown the
 * Analytics tab renders (STAR completeness chart, answer-length
 * distribution, time distribution, etc.). Produced inline by the
 * same analyze LLM call that builds the report; runs through a
 * dedicated post-response guardrails pass before persistence so a
 * hallucinated `referenced_item_id` / `suggested_item_id` (a UUID
 * that doesn't exist in `projects` / `stories`) can't slip into
 * the saved JSONB.
 *
 * The whole array is OPTIONAL on the report:
 *   - Old reports persisted before this field existed must still
 *     parse — the UI renders a graceful "analytics not available"
 *     state when the field is absent.
 *   - When the LLM's first attempt fails Zod validation we retry
 *     once with a schema-correction tail; if the retry also fails
 *     we strip the field rather than fail the whole analysis.
 *
 * Star signals: per the spec, behavioral / technical / system_design /
 * motivation / other questions get a real STAR assessment (each of
 * the four dimensions is 'present' | 'weak' | 'missing'). For
 * questions where STAR doesn't apply (closing, clarification) the
 * model emits 'na' across all four dimensions; aggregation helpers
 * filter the all-'na' entries out of the chart denominator.
 */
const starSignalSchema = z.enum(["present", "weak", "missing", "na"]);
export type StarSignal = z.infer<typeof starSignalSchema>;

/**
 * The per-question STAR rollup. Always four keys, even when the
 * question type is 'closing' / 'clarification' (those four become
 * 'na').
 */
export const starSignalsSchema = z.object({
  situation: starSignalSchema,
  task: starSignalSchema,
  action: starSignalSchema,
  result: starSignalSchema,
});
export type StarSignals = z.infer<typeof starSignalsSchema>;

/**
 * How the candidate used (or could have used) their profile while
 * answering this question.
 *
 *   status='used' →
 *     The candidate referenced a project or story from their
 *     profile. `referenced_item_*` is populated; `suggested_item_*`
 *     is absent.
 *   status='available_unused' →
 *     A stronger profile item existed but wasn't referenced. The
 *     UI surfaces a "rebuild with this item highlighted" CTA. Both
 *     `referenced_item_*` (the candidate's actual choice or null
 *     equivalent — usually omitted) and `suggested_item_*` are
 *     populated.
 *   status='no_match' →
 *     The question doesn't have a clear profile match (e.g.
 *     a closing or clarification question). Only `status` is set.
 *
 * Guardrails 1 and 2 verify the UUIDs against the user's actual
 * `projects` / `stories` rows BEFORE persistence and reset the
 * field to `{ status: 'no_match' }` when either points at a UUID
 * the user doesn't own (catches hallucinated references).
 */
export const profileLeverageSchema = z.object({
  status: z.enum(["used", "available_unused", "no_match"]),
  referenced_item_type: z.enum(["project", "story"]).optional(),
  referenced_item_id: z.uuid().optional(),
  referenced_item_label: z.string().max(200).optional(),
  suggested_item_id: z.uuid().optional(),
  suggested_item_label: z.string().max(200).optional(),
});
export type ProfileLeverage = z.infer<typeof profileLeverageSchema>;

export const perQuestionAnalyticsSchema = z.object({
  /**
   * UUID of the question artifact this entry refers to, when one
   * exists. OPTIONAL because the analytics tab is now driven off
   * `questionsCovered` (which includes `transcript_inferred`
   * questions that have NO backing artifact row in the
   * `artifacts` table) — see the prompt section
   * "Per-question analytics" in `lib/llm/prompt.ts` for the full
   * sourcing rule.
   *
   * Guardrail 3 still verifies it exists in `artifacts` for the
   * session when it IS provided, and drops the entry on mismatch
   * (catches hallucinated UUIDs). When the field is absent the
   * entry passes guardrail 3 unconditionally — the per-question
   * card / rebuild launcher fall back to the question text and
   * the array index for keying / labelling.
   *
   * UI consequence: cards without an `artifact_id` can still be
   * rendered (we use the array index as the React key) and the
   * rebuild button still works (`source_artifact_id` on the
   * rebuild POST is already optional — only `source_session_id`
   * is load-bearing for ownership).
   */
  artifact_id: z.uuid().optional(),
  /**
   * Question text duplicated from the artifact for convenience —
   * the UI doesn't have to join back to the artifacts table to
   * render the row title.
   */
  question_text: z.string().max(1000),
  /**
   * Estimated duration of the candidate's answer to this question,
   * in seconds. Used by the time-distribution and length-discipline
   * charts. Guardrail 4 sanity-checks the sum against the transcript
   * duration but doesn't reject — it just logs a warning.
   */
  duration_seconds: z.number().int().min(0),
  question_type: z.enum([
    "behavioral",
    "technical",
    "system_design",
    "motivation",
    "closing",
    "clarification",
    "other",
  ]),
  star_signals: starSignalsSchema,
  /**
   * Filler words per minute in the candidate's answer chunk for
   * this question. Rounded to 1 decimal place by the LLM.
   */
  filler_per_minute: z.number().min(0),
  /** First-person singular pronoun count ("I", "me", "my", "mine"). */
  i_count: z.number().int().min(0),
  /** First-person plural pronoun count ("we", "us", "our", "ours"). */
  we_count: z.number().int().min(0),
  profile_leverage: profileLeverageSchema,
});
export type PerQuestionAnalytics = z.infer<typeof perQuestionAnalyticsSchema>;

/**
 * Output schema for the analytics-only parallel LLM call. The full
 * `reportSchema` is not used here so the model's output budget isn't
 * wasted on fields that are generated in the concurrent core call.
 *
 * Both arrays must line up 1:1 in the same order, matching the
 * constraint in the system prompt and the full `reportSchema`.
 */
export const analyticsOutputSchema = z.object({
  questionsCovered: z.array(questionCoveredSchema).max(30).default([]),
  per_question_analytics: z
    .array(perQuestionAnalyticsSchema)
    .max(30)
    .optional(),
});
export type AnalyticsOutput = z.infer<typeof analyticsOutputSchema>;

/**
 * Output schema for the stories-only parallel LLM call. Mirrors the
 * `storyHighlights` field on `reportSchema` so the model can populate
 * the section in a concurrent call instead of inflating the core
 * narrative's output budget.
 *
 * Empty array is valid (and required) for non-behavioral rounds where
 * the prompt explicitly tells the model to emit `[]` — see
 * `Story highlights` in `lib/llm/prompt.ts`.
 */
export const storyHighlightsOutputSchema = z.object({
  storyHighlights: z.array(storyHighlightSchema).max(6).default([]),
});
export type StoryHighlightsOutput = z.infer<typeof storyHighlightsOutputSchema>;

export const reportSchema = z.object({
  /** Top of the page — 2-4 sentence summary, second person. */
  executiveSummary: z.string().min(1).max(1200),
  strengths: z.array(strengthSchema).min(1).max(6),
  improvements: z.array(improvementSchema).min(1).max(6),
  communicationSignals: communicationSignalsSchema,
  roundSpecific: roundSpecificSchema,
  aiRead: aiReadSchema,
  /**
   * Questions Sonnet identified across the transcript + artifacts,
   * each with a confidence band and a source tag. Optional with a
   * default of `[]` so legacy reports persisted before the field
   * was introduced still validate; new reports always populate it.
   * The renderer hides the section when the list is empty.
   *
   * Capped at 30: a 60-min round rarely contains more than 15-20
   * distinct questions; 30 is comfortable headroom without letting
   * a runaway model pad the report.
   */
  questionsCovered: z.array(questionCoveredSchema).max(30).default([]),
  /**
   * Per-question analytics — the Analytics tab's source of truth.
   * Optional with no default (the renderer reads `undefined` as
   * "analytics not available for this report") so legacy reports
   * persisted before this field existed still validate. Capped at
   * 30 to match `questionsCovered` (the two should track each
   * other in length, give or take dropped entries from guardrail 3).
   */
  per_question_analytics: z
    .array(perQuestionAnalyticsSchema)
    .max(30)
    .optional(),
  /**
   * Per-story highlights — promoted to top-level in 2026-05 so
   * the section renders as its own tab for ALL round types, not
   * just buried inside the Behavioral round detail. Optional with
   * a `.default([])` so legacy reports persisted before this field
   * existed still parse; the UI hides the section when empty.
   */
  storyHighlights: z.array(storyHighlightSchema).max(6).default([]),
});
export type Report = z.infer<typeof reportSchema>;
