import "server-only";

import { features } from "@/lib/env";
import {
  getLlmClient,
  LLM_MODEL_SMALL,
  LlmNotConfiguredError,
  LlmValidationError,
} from "@/lib/llm";
import {
  FAILURE_THEMES,
  type RebuildQuestionTheme,
} from "@/lib/db/schema";

import { normalizeForVerbatim, profileContains } from "./guardrails";
import {
  isProfileContextEmpty,
  loadRebuildProfileContext,
  renderProfileContext,
  type RebuildProfileContext,
} from "./profile-context";
import {
  SUGGEST_PROMPT_VERSION,
  SUGGEST_SYSTEM_PROMPT,
  renderSuggestUserPrompt,
} from "./suggest-prompt";
import {
  suggestedResponseSchema,
  type SuggestedResponse,
  type SuggestionSource,
} from "./schemas";

/**
 * One-shot suggested-response pipeline. Runs once per
 * `POST /api/rebuilds/:id/suggest-response`.
 *
 * Steps:
 *   1. Load + render the candidate's profile snapshot (resume +
 *      projects + stories — same `loadRebuildProfileContext` the
 *      critique pipeline uses, with the same `exclude_*` toggles
 *      respected).
 *   2. Call the small model with the suggest system prompt + the
 *      rendered user prompt (question + theme + profile block).
 *   3. JSON.parse + zod validate. On schema failure, retry ONCE
 *      with a "your previous response did not match" tail.
 *   4. Run the verbatim guardrail: every `sources[].field_value`
 *      must appear in the rendered profile context (whitespace-
 *      normalized). On any trip, fall back to a synthetic
 *      suggestion so the user gets *something* instead of a
 *      generic 502.
 *
 * Daily-rate limiting (10 suggestions per rebuild per 24h) is
 * the route handler's job — the runner just runs.
 *
 * IMPORTANT — product stance:
 * Unlike `runCritique`, this runner DOES generate text the user
 * can read aloud. The product position changed: the AI critique
 * still doesn't write narrative on the candidate's behalf, but
 * "Generate AI draft" explicitly does — to give the user
 * something to compare their own answer against. The UI surfaces
 * a persistent "this is a starting point — make it yours" caveat
 * alongside the rendered suggestion.
 */

/* ────────────────────────────────────────────────────────────── */
/* Public surface                                                 */
/* ────────────────────────────────────────────────────────────── */

export class RebuildSuggestValidationError extends Error {
  readonly code = "llm_validation_failed";
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "RebuildSuggestValidationError";
  }
}

export interface RunSuggestResponseResult {
  /** The suggestion payload to store on `ai_suggested_response_json` and return. */
  suggestion: SuggestedResponse;
  /**
   * Whether the verbatim guardrail accepted every `sources[]`
   * citation (true) or whether we fell back to a synthetic
   * suggestion (false). The route uses this to skip the credit
   * charge — the user didn't get the value of a real, grounded
   * suggestion, so we don't bill them.
   */
  passedGuardrails: boolean;
  /**
   * True when the candidate's profile has no usable content (no
   * resume row, no projects, no stories). The LLM call is skipped
   * entirely — generating against an empty profile produces purely
   * generic text that is useless in an interview. The route handler
   * converts this to a 422 `profile_empty` response so the UI can
   * show a "fill in your profile first" panel instead of a
   * placeholder draft.
   *
   * Always false when `passedGuardrails === true`.
   */
  profileEmpty?: boolean;
  /**
   * Pinned model + prompt version stamps so analytics can trace
   * which prompt produced which suggestion even after a future
   * prompt revision. Mirrors `RunCritiqueResult`.
   */
  modelVersion: string;
  promptVersion: string;
  /**
   * Short reason string when `passedGuardrails === false`. Logged
   * by the route. Empty when guardrails passed.
   */
  guardrailReason?: string;
}

/**
 * Minimal context the runner needs to call the LLM. Both the
 * Practice Rebuild surface (where the question is the original
 * interview question and the row is `story_rebuilds`) and the
 * Story Bank surface (where the "question" is the saved story's
 * title and the row is `stories`) project to this shape so they
 * can share the LLM pipeline + prompt + guardrail wholesale.
 *
 * `userId` is the only field used for profile loading; the runner
 * does NOT scope-check it against any other row id (the route
 * handler is responsible for ownership). `questionText` is the
 * thing the LLM is drafting an answer to. `questionTheme` is one
 * of `REBUILD_QUESTION_THEMES` (which is the same set as
 * `STORY_THEMES`); it controls (a) which profile slabs render and
 * (b) whether `whatIWouldChange` is required by the schema.
 */
export interface SuggestionContext {
  userId: string;
  questionText: string;
  questionTheme: RebuildQuestionTheme | null;
}

export interface RunSuggestResponseArgs {
  context: SuggestionContext;
  /**
   * Optionally pass a pre-resolved profile context so unit tests
   * can stub it without a DB hit. The runner falls back to
   * `loadRebuildProfileContext` when omitted.
   */
  profile?: RebuildProfileContext;
}

/**
 * Run a suggestion end-to-end. Throws:
 *   - `LlmNotConfiguredError` in dev environments without
 *     a configured LLM backend. The route handler maps this to 503.
 *
 * Does NOT throw on schema-validation or guardrail failure —
 * returns a synthetic suggestion with `passedGuardrails: false`
 * so the user always gets something they can read, and the route
 * still skips the credit charge on `passedGuardrails === false`.
 */
export async function runSuggestResponse(
  args: RunSuggestResponseArgs,
): Promise<RunSuggestResponseResult> {
  const { context } = args;
  const profile =
    args.profile ??
    (await loadRebuildProfileContext({
      userId: context.userId,
      theme: context.questionTheme,
    }));

  // Pre-flight: if the profile has no usable content at all, skip
  // the LLM call entirely. Generating against an empty profile
  // produces purely generic text ("In my previous role, I led a
  // team…") because every field in the rendered context block is
  // "not provided". That text passes the verbatim guardrail (empty
  // sources[] is acceptable) but is useless in an interview. We
  // surface a distinct `profileEmpty` flag so the route can return
  // a 422 and the UI can show a "fill in your profile first" panel.
  if (isProfileContextEmpty(profile)) {
    return {
      suggestion: buildEmptyProfilePlaceholder(context.questionTheme),
      profileEmpty: true,
      passedGuardrails: false,
      modelVersion: LLM_MODEL_SMALL,
      promptVersion: SUGGEST_PROMPT_VERSION,
      guardrailReason: "profile_empty",
    };
  }

  const profileBlock = renderProfileContext(profile, {
    theme: context.questionTheme,
  });

  const failureShaped = isFailureShaped(context.questionTheme);
  const userPrompt = renderSuggestUserPrompt({
    profileContextBlock: profileBlock,
    questionText: context.questionText,
    questionTheme: context.questionTheme,
    isFailureShaped: failureShaped,
  });

  let raw: string;
  try {
    raw = await callLlm({ profileBlock, userPrompt });
  } catch (err) {
    if (err instanceof RebuildSuggestValidationError) {
      return buildSyntheticFallback({
        context,
        reason: `validation: ${err.message}`,
      });
    }
    throw err;
  }

  let parsed: SuggestedResponse;
  try {
    parsed = parseAndValidateSuggestion(raw);
  } catch (err) {
    const reason =
      err instanceof RebuildSuggestValidationError
        ? err.message
        : "validation_drift";
    return buildSyntheticFallback({
      context,
      reason: `parse: ${reason}`,
    });
  }

  // Normalize: for non-failure questions, force `whatIWouldChange`
  // to null even if the model emitted a sentence. The renderer
  // hides the field when it's null, so this keeps the UI honest
  // about the question shape.
  if (!failureShaped) {
    parsed = { ...parsed, whatIWouldChange: null };
  }

  // Verbatim guardrail: every sources[].field_value must appear
  // in the rendered profile context. Anything that doesn't is the
  // model hallucinating evidence — fall back to a synthetic
  // suggestion the same way the critique pipeline handles
  // hallucinated profile_reference values.
  const hallucinated = findHallucinatedSources(parsed.sources, profile);
  if (hallucinated.length > 0) {
    return buildSyntheticFallback({
      context,
      reason:
        `hallucinated source(s): ${hallucinated
          .map((s) => `'${s.field_path}'`)
          .join(", ")}`,
    });
  }

  return {
    suggestion: parsed,
    passedGuardrails: true,
    modelVersion: LLM_MODEL_SMALL,
    promptVersion: SUGGEST_PROMPT_VERSION,
  };
}

/* ────────────────────────────────────────────────────────────── */
/* Helpers                                                        */
/* ────────────────────────────────────────────────────────────── */

export function isFailureShaped(theme: string | null | undefined): boolean {
  if (!theme) return false;
  return FAILURE_THEMES.has(theme as RebuildQuestionTheme);
}

/**
 * Returns the subset of `sources` whose `field_value` is NOT
 * present (whitespace-normalized) in the candidate's profile
 * context. Empty array iff every citation is grounded.
 *
 * Exported so tests can pin the verbatim-check behavior without
 * setting up an LLM round-trip.
 */
export function findHallucinatedSources(
  sources: ReadonlyArray<SuggestionSource>,
  profile: RebuildProfileContext,
): SuggestionSource[] {
  const out: SuggestionSource[] = [];
  for (const s of sources) {
    if (normalizeForVerbatim(s.field_value).length === 0) continue;
    if (!profileContains(profile, s.field_value)) {
      out.push(s);
    }
  }
  return out;
}

/**
 * Build a minimal placeholder for the `profileEmpty` path. This
 * value is never displayed — the route returns 422 immediately and
 * the UI shows a "fill in your profile" panel. It exists only to
 * satisfy the TypeScript type requirement that `suggestion` is
 * always present on `RunSuggestResponseResult`.
 */
function buildEmptyProfilePlaceholder(
  theme: string | null | undefined,
): SuggestedResponse {
  const failureShaped = isFailureShaped(theme);
  return {
    headline: "",
    situation: "",
    task: "",
    action: "",
    result: "",
    whatIWouldChange: failureShaped ? "" : null,
    sources: [],
    caveats: ["Profile has no usable content — draft generation skipped."],
  };
}

/**
 * Synthesize a minimal valid suggestion when the model returns
 * something we can't trust (validation failure twice in a row,
 * or hallucinated citations). The synthetic suggestion is
 * intentionally generic — we don't have grounded prose, so we
 * give the user a structural scaffold + clear caveat that AI
 * generation failed.
 *
 * `passedGuardrails: false` is the load-bearing flag — the route
 * uses it to skip the credit charge AND to log the failure. The
 * user is not billed for a suggestion we couldn't actually generate.
 */
function buildSyntheticFallback(args: {
  context: SuggestionContext;
  reason: string;
}): RunSuggestResponseResult {
  const failureShaped = isFailureShaped(args.context.questionTheme);

  const suggestion: SuggestedResponse = {
    headline: "[Draft a one-sentence headline stating the OUTCOME of your story.]",
    situation:
      "[Set the scene in 2-3 sentences: when, where, who else was there. Pull from a specific project or story in your profile.]",
    task: "[State YOUR specific responsibility in first person. Use 'I', not 'we'.]",
    action:
      "[Describe what you specifically did. Step by step where relevant. First person.]",
    result:
      "[Quantify the outcome. Pull a number from your profile's outcomes_with_metrics or a story's result if available.]",
    whatIWouldChange: failureShaped
      ? "[For a failure question, name a specific behavior change you'd make next time.]"
      : null,
    sources: [],
    caveats: [
      "AI generation didn't produce a grounded draft this time. Try again, or fill in the placeholders yourself using your profile.",
    ],
  };

  return {
    suggestion,
    passedGuardrails: false,
    modelVersion: LLM_MODEL_SMALL,
    promptVersion: SUGGEST_PROMPT_VERSION,
    guardrailReason: args.reason,
  };
}

/* ────────────────────────────────────────────────────────────── */
/* LLM transport                                                  */
/* ────────────────────────────────────────────────────────────── */

const MAX_RETRIES_ON_VALIDATION = 1;

/**
 * Output ceiling for the suggestion JSON. Sized for a worst-case
 * response: 5 STAR fields × 2000 chars + 200-char headline +
 * 2000-char whatIWouldChange + ~20 sources × (500 + 5000) chars
 * + ~20 caveats × 500 chars. That's ~135 KB worst-case JSON,
 * which fits comfortably under the 4096-token cap (the same cap
 * the critique runner uses for similar reasons). If we ever see
 * truncation in production, raise here AND in the prompt
 * (caveats explaining the budget) in lockstep.
 */
const MAX_OUTPUT_TOKENS = 4096;

interface LlmArgs {
  profileBlock: string;
  userPrompt: string;
}

async function callLlm(args: LlmArgs): Promise<string> {
  if (!features.llmAnalysis) throw new LlmNotConfiguredError();
  const client = getLlmClient();

  let lastRaw = "";

  for (let attempt = 0; attempt <= MAX_RETRIES_ON_VALIDATION; attempt++) {
    const userMessageText =
      attempt === 0
        ? args.profileBlock + "\n\n" + args.userPrompt
        : args.profileBlock +
          "\n\n" +
          args.userPrompt +
          "\n\n" +
          "Your previous response did not match the required JSON schema. " +
          "Return ONLY a valid JSON object matching the schema in the system " +
          "prompt — no Markdown fencing, no commentary. Previous response:\n\n" +
          lastRaw;

    const response = await client.chat.completions.create({
      model: LLM_MODEL_SMALL,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SUGGEST_SYSTEM_PROMPT },
        { role: "user", content: userMessageText },
      ],
    });

    const text = (response.choices[0]?.message?.content || "").trim();

    lastRaw = text;

    if (response.choices[0]?.finish_reason === "length") {
      throw new RebuildSuggestValidationError(
        `Rebuild suggestion was truncated at the max_tokens cap (${MAX_OUTPUT_TOKENS}). Either the prompt is asking for too much, or the cap needs raising.`,
        text,
      );
    }

    const parsed = tryParseValidated(text);
    if (parsed.ok) return text;

    if (attempt === MAX_RETRIES_ON_VALIDATION) {
      throw new RebuildSuggestValidationError(
        `Rebuild suggestion failed schema validation: ${parsed.error}`,
        text,
      );
    }
  }

  throw new LlmValidationError("rebuild suggestion unreachable", lastRaw);
}

/**
 * Strict parse: strips an optional Markdown fence the model
 * sometimes adds despite instructions, JSON.parses, and validates
 * against the zod schema. Throws `RebuildSuggestValidationError`
 * on failure; the caller maps that to a synthetic fallback.
 */
export function parseAndValidateSuggestion(raw: string): SuggestedResponse {
  const result = tryParseValidated(raw);
  if (result.ok) return result.value;
  throw new RebuildSuggestValidationError(result.error, raw);
}

interface ParseOk {
  ok: true;
  value: SuggestedResponse;
}
interface ParseErr {
  ok: false;
  error: string;
}

function tryParseValidated(raw: string): ParseOk | ParseErr {
  // Defense layer 1: strip a Markdown fence the model sometimes
  // wraps the JSON in despite the system prompt saying not to.
  let stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  // Defense layer 2: extract the outermost JSON object if the
  // model added prose around it. Same approach as `critique.ts` —
  // slice from the first `{` to the last `}`.
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    stripped = stripped.slice(firstBrace, lastBrace + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${(err as Error).message}` };
  }

  const result = suggestedResponseSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, value: result.data };
}
