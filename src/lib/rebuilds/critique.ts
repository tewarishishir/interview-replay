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
  type StoryRebuild,
} from "@/lib/db/schema";

import {
  GUARDRAIL_EVENTS,
  buildFallbackCritique,
  runGuardrails,
  type GuardrailFailure,
} from "./guardrails";
import {
  loadRebuildProfileContext,
  renderProfileContext,
  type RebuildProfileContext,
} from "./profile-context";
import {
  REBUILD_PROMPT_VERSION,
  REBUILD_SYSTEM_PROMPT,
  renderRebuildUserPrompt,
} from "./prompt";
import {
  critiqueResponseSchema,
  type CritiqueResponse,
  type DimensionFeedback,
} from "./schemas";

/**
 * One-shot critique pipeline. Runs once per
 * `POST /api/rebuilds/:id/critique`.
 *
 * Steps:
 *   1. Load + render the candidate's profile snapshot.
 *   2. Validate that the rebuild's draft is rich enough to
 *      critique (situation/action/result non-empty;
 *      what_i_would_change non-empty for failure themes).
 *   3. Call the LLM with the system prompt and the
 *      rendered user prompt.
 *   4. JSON.parse + zod validate. On schema failure, retry
 *      ONCE with a "your previous response did not match" tail.
 *   5. Run all four guardrails. On any trip, fall back to a
 *      basic critique with profile_reference fields stripped
 *      and emit the trip events.
 *
 * Cost: ~$0.005 per call at Haiku prices. The route handler
 * does NOT charge user credits — the spec marks this as
 * "part of the report value".
 *
 * Daily-rate limiting (10 critiques per rebuild per 24h) is the
 * route handler's job — the runner just runs.
 */

/* ────────────────────────────────────────────────────────────── */
/* Public surface                                                 */
/* ────────────────────────────────────────────────────────────── */

export class RebuildCritiquePreflightError extends Error {
  readonly code: "missing_required_fields";
  readonly missing: ReadonlyArray<string>;
  constructor(missing: ReadonlyArray<string>) {
    super(
      `Critique preflight failed: missing required draft fields ${missing.join(", ")}`,
    );
    this.name = "RebuildCritiquePreflightError";
    this.code = "missing_required_fields";
    this.missing = missing;
  }
}

export class RebuildCritiqueValidationError extends Error {
  readonly code = "llm_validation_failed";
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "RebuildCritiqueValidationError";
  }
}

export interface RunCritiqueResult {
  /** The critique payload to store on `ai_critique_json` and return. */
  critique: CritiqueResponse;
  /**
   * Whether we returned the model's raw response (true) or fell
   * back to a basic structural critique (false). Surfaced so the
   * route can stamp the right analytics trail without
   * the caller having to inspect the failures list.
   */
  passedGuardrails: boolean;
  /**
   * Guardrail failures, when `passedGuardrails === false`.
   * Empty when guardrails passed. The caller emits each one as
   * a log event keyed on `failure.event`.
   */
  guardrailFailures: ReadonlyArray<GuardrailFailure>;
  /**
   * Pinned model + prompt version stamps so analytics can trace
   * which prompt produced which critique even after a future
   * prompt revision. Mirror of how the analyze worker tags the
   * report row with `model_version` + `rubric_version`.
   */
  modelVersion: string;
  promptVersion: string;
}

export interface RunCritiqueArgs {
  rebuild: StoryRebuild;
  /**
   * Optionally pass a pre-resolved profile context so
   * unit tests can stub it without a DB hit. The runner falls
   * back to `loadRebuildProfileContext` when omitted.
   */
  profile?: RebuildProfileContext;
}

/**
 * Run a critique end-to-end. Throws:
 *   - `RebuildCritiquePreflightError` when the draft lacks a
 *     required field. The route handler maps this to a 400 with
 *     the field list.
 *   - `LlmNotConfiguredError` in dev environments without
 *     a configured LLM backend. The route handler maps this to 503.
 *
 * Does NOT throw `RebuildCritiqueValidationError` anymore. When the
 * model returns something the validator can't parse even after the
 * retry, we synthesize a basic structural critique (the same shape
 * the guardrail-trip path produces) and return it with
 * `passedGuardrails: false` + a synthetic `GuardrailFailure` that
 * captures the validation error. This avoids the "We couldn't
 * generate a critique" 502 the user kept seeing — they always get
 * SOMETHING actionable, and the route still skips the credit charge
 * on `passedGuardrails === false`. The route is responsible for
 * logging the synthetic failure so on-call still sees the
 * pattern.
 */
export async function runCritique(
  args: RunCritiqueArgs,
): Promise<RunCritiqueResult> {
  preflightDraft(args.rebuild);

  const profile =
    args.profile ??
    (await loadRebuildProfileContext({
      userId: args.rebuild.userId,
      theme: (args.rebuild.questionTheme as RebuildQuestionTheme | null) ?? null,
    }));

  const profileBlock = renderProfileContext(profile, {
    theme: (args.rebuild.questionTheme as RebuildQuestionTheme | null) ?? null,
  });

  const userPrompt = renderRebuildUserPrompt({
    profileContextBlock: profileBlock,
    questionText: args.rebuild.questionText,
    questionTheme: args.rebuild.questionTheme,
    draft: {
      headline: args.rebuild.headline,
      situation: args.rebuild.situation,
      task: args.rebuild.task,
      action: args.rebuild.action,
      result: args.rebuild.result,
      whatIWouldChange: args.rebuild.whatIWouldChange,
    },
    isFailureShaped: isFailureShaped(args.rebuild.questionTheme),
  });

  let raw: string;
  try {
    raw = await callLlm({
      profileBlock,
      userPrompt,
    });
  } catch (err) {
    if (err instanceof RebuildCritiqueValidationError) {
      // Model couldn't produce a schema-valid response twice in a
      // row. Return a synthetic-fallback critique so the user sees
      // SOMETHING they can act on rather than a generic error
      // banner. The synthetic GuardrailFailure carries the
      // validator's error so the route's logging instrumentation
      // (which already iterates `guardrailFailures`) can log it
      // without a separate code path.
      return buildSyntheticValidationFallback({
        rebuild: args.rebuild,
        reason: err.message,
      });
    }
    throw err;
  }

  let parsed: CritiqueResponse;
  try {
    parsed = parseAndValidate(raw);
  } catch (err) {
    // `callLlm` already validates before returning, so we only
    // land here if the parse layer drifts (e.g. a future refactor
    // splits the call site without keeping the inner validator in
    // sync). Treat the same as a validation failure — graceful
    // fallback, no charge, logged warning.
    const reason =
      err instanceof RebuildCritiqueValidationError ? err.message : "validation_drift";
    return buildSyntheticValidationFallback({
      rebuild: args.rebuild,
      reason,
    });
  }
  const guardrailResult = runGuardrails({
    critique: parsed,
    profile,
  });

  if (guardrailResult.ok) {
    return {
      critique: parsed,
      passedGuardrails: true,
      guardrailFailures: [],
      modelVersion: LLM_MODEL_SMALL,
      promptVersion: REBUILD_PROMPT_VERSION,
    };
  }

  // Guardrail trip → fall back to a basic structural critique
  // with profile_reference fields stripped. The caller is
  // responsible for emitting `guardrailFailures[*].event` to
  // the log; we don't do that here so the runner stays test-
  // friendly (no side effects).
  const fallback = buildFallbackCritique({
    original: parsed,
    failures: guardrailResult.failures,
  });

  return {
    critique: fallback,
    passedGuardrails: false,
    guardrailFailures: guardrailResult.failures,
    modelVersion: LLM_MODEL_SMALL,
    promptVersion: REBUILD_PROMPT_VERSION,
  };
}

/**
 * Synthesize a minimal valid critique when the LLM returns
 * something we can't parse twice in a row. The synthetic critique
 * is intentionally generic — we don't have a trustworthy LLM
 * grade, so we just walk the candidate through the STAR sections
 * they themselves filled in and remind them to reflect. We return
 * EXACTLY the seven (or six, non-failure-shaped) dimensions the
 * happy path emits so the renderer never has to special-case a
 * fallback shape.
 *
 * `passedGuardrails: false` is still set so the route's analytics
 * layer can distinguish a synthetic-fallback run from a clean one
 * (the route uses `guardrailFailures[]` to surface model-
 * quality regressions). Billing-wise the route now charges on
 * BOTH branches — the LLM round-trip happened, the persist layer
 * wrote a structured critique, and the user sees a real critique
 * view. See `route.ts`'s charging docstring.
 */
function buildSyntheticValidationFallback(args: {
  rebuild: StoryRebuild;
  reason: string;
}): RunCritiqueResult {
  const failure: GuardrailFailure = {
    // We reuse the closest existing event so the monitoring funnel
    // surfaces "model returned junk" alongside the other
    // model-quality issues; a separate event would split the
    // signal across two dashboards without changing the response.
    event: GUARDRAIL_EVENTS.exampleSentence,
    reason: `LLM validation fallback: ${args.reason}`,
  };

  const includeBehavioralChange = isFailureShaped(args.rebuild.questionTheme);

  const dimensions: DimensionFeedback[] = [
    {
      dimension: "headline",
      status: args.rebuild.headline?.trim() ? "needs_work" : "missing",
      quoted_excerpt: args.rebuild.headline ?? "",
      what_to_check:
        "Re-read your one-line headline. Does it state the OUTCOME of the story, not just the topic?",
    },
    {
      dimension: "star_completeness",
      status: hasAllStarFields(args.rebuild) ? "needs_work" : "missing",
      quoted_excerpt: "",
      what_to_check:
        "Check that Situation, Task, Action, and Result are each at least 2-3 sentences. Empty or one-line sections are the most common drop-off.",
    },
    {
      dimension: "first_person",
      status: "needs_work",
      quoted_excerpt: "",
      what_to_check:
        "Re-read your Task and Action. Are you using \"I\" (your decision, your work) instead of \"we\" (the team's collective effort)?",
    },
    {
      dimension: "quantification",
      status: args.rebuild.result?.trim() ? "needs_work" : "missing",
      quoted_excerpt: args.rebuild.result ?? "",
      what_to_check:
        "Add at least one number to your Result — percentage change, time saved, headcount, revenue, latency, anything measurable.",
    },
  ];

  if (includeBehavioralChange) {
    dimensions.push({
      dimension: "behavioral_change",
      status: args.rebuild.whatIWouldChange?.trim() ? "needs_work" : "missing",
      quoted_excerpt: args.rebuild.whatIWouldChange ?? "",
      what_to_check:
        "For a failure story, complete the sentence: \"Looking back, what I should have done differently is…\" Be specific.",
    });
  }

  dimensions.push(
    {
      dimension: "profile_consistency",
      status: "needs_work",
      quoted_excerpt: "",
      what_to_check:
        "Verify this story is consistent with the project / role / dates already in your profile.",
    },
    {
      dimension: "profile_leverage",
      status: "needs_work",
      quoted_excerpt: "",
      what_to_check:
        "Confirm whether your profile has a related project or story you could pull a specific detail from.",
    },
  );

  const critique: CritiqueResponse = {
    overall_assessment:
      "We had trouble generating a detailed critique for this draft just now — this often resolves on retry. " +
      "In the meantime, here's the structural checklist you can self-review against.",
    dimension_feedback: dimensions,
    next_step_suggestion:
      "Click \"Get critique\" again in a moment. If it keeps failing, revise the section flagged \"missing\" first — those move the structure most.",
  };

  return {
    critique,
    passedGuardrails: false,
    guardrailFailures: [failure],
    modelVersion: LLM_MODEL_SMALL,
    promptVersion: REBUILD_PROMPT_VERSION,
  };
}

function hasAllStarFields(rebuild: StoryRebuild): boolean {
  return (
    !!rebuild.situation?.trim() &&
    !!rebuild.task?.trim() &&
    !!rebuild.action?.trim() &&
    !!rebuild.result?.trim()
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Helpers                                                        */
/* ────────────────────────────────────────────────────────────── */

/**
 * Preflight the draft — before paying for an LLM call we make
 * sure the required STAR fields are non-empty (and
 * `what_i_would_change` for failure themes). Throws
 * `RebuildCritiquePreflightError` with the missing field list
 * the route handler can surface as a 400.
 *
 * Exported so the route can do an early check to avoid the
 * LLM round-trip on a clearly-empty submission.
 */
export function preflightDraft(rebuild: StoryRebuild): void {
  const missing: string[] = [];
  if (!rebuild.situation?.trim()) missing.push("situation");
  if (!rebuild.action?.trim()) missing.push("action");
  if (!rebuild.result?.trim()) missing.push("result");
  if (
    isFailureShaped(rebuild.questionTheme) &&
    !rebuild.whatIWouldChange?.trim()
  ) {
    missing.push("what_i_would_change");
  }
  if (missing.length > 0) {
    throw new RebuildCritiquePreflightError(missing);
  }
}

export function isFailureShaped(
  theme: string | null | undefined,
): boolean {
  if (!theme) return false;
  // Cast is safe — FAILURE_THEMES is a Set of literal strings;
  // membership is decided by string equality.
  return FAILURE_THEMES.has(theme as RebuildQuestionTheme);
}

/* ────────────────────────────────────────────────────────────── */
/* LLM transport                                                  */
/* ────────────────────────────────────────────────────────────── */

const MAX_RETRIES_ON_VALIDATION = 1;
/**
 * Output ceiling for the critique JSON.
 *
 * Schema worst case: 7 dimensions × (2 000-char `quoted_excerpt` +
 * 2 000-char `what_to_check` + 5 000-char `profile_reference.field_value`),
 * plus a 2 000-char `overall_assessment` and a 1 000-char
 * `next_step_suggestion` ≈ 66 k chars ≈ 16-17 k tokens.
 *
 * History:
 *   - 2 048 tokens: original cap. Truncated immediately on real
 *     critiques.
 *   - 4 096 tokens: bumped after the first round of truncations.
 *     Held for typical critiques but kept truncating real ones
 *     once Haiku surfaced 2-3 verbatim profile excerpts. The
 *     truncation surfaced as `RebuildCritiqueValidationError`
 *     ("Unterminated string in JSON") and the user saw the
 *     synthetic-fallback critique with "We had trouble generating
 *     a detailed critique for this draft just now…"
 *   - 8 192 tokens (current): same pattern PR #151 applied to
 *     the analyze worker. Still well below the schema's worst
 *     case (the schema is intentionally permissive — guardrails
 *     trim verbose responses post-parse) but enough headroom
 *     that realistic Haiku outputs stop hitting the cap.
 *
 * Cost impact is negligible — Haiku 4.5 output is $5 / MTok and
 * the cap only matters when the model actually emits that many
 * tokens; typical critiques are 2-4 k output tokens regardless
 * of the cap.
 */
const MAX_OUTPUT_TOKENS = 8192;

interface LlmArgs {
  profileBlock: string;
  userPrompt: string;
}

async function callLlm(args: LlmArgs): Promise<string> {
  if (!features.llmAnalysis) throw new LlmNotConfiguredError();
  const client = getLlmClient();

  let lastRaw = "";

  const callStartedAt = Date.now();

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
        { role: "system", content: REBUILD_SYSTEM_PROMPT },
        { role: "user", content: userMessageText },
      ],
    });

    const text = (response.choices[0]?.message?.content || "").trim();

    lastRaw = text;

    console.warn(
      `[rebuild-critique] llm_call_complete attempt=${attempt} ` +
        `elapsed_ms=${Date.now() - callStartedAt} ` +
        `completion_tokens=${response.usage?.completion_tokens ?? "?"} ` +
        `max_tokens=${MAX_OUTPUT_TOKENS} ` +
        `finish_reason=${response.choices[0]?.finish_reason ?? "unknown"}`,
    );

    if (response.choices[0]?.finish_reason === "length") {
      console.warn(
        `[rebuild-critique] truncated_at_max_tokens cap=${MAX_OUTPUT_TOKENS} ` +
          `completion_tokens=${response.usage?.completion_tokens ?? "?"} ` +
          `— bump MAX_OUTPUT_TOKENS if this fires repeatedly.`,
      );
      throw new RebuildCritiqueValidationError(
        `Rebuild critique was truncated at the max_tokens cap (${MAX_OUTPUT_TOKENS}). The prompt or output schema needs trimming, or the cap needs raising.`,
        text,
      );
    }

    const parsed = tryParseValidated(text);
    if (parsed.ok) return text;

    console.warn(
      `[rebuild-critique] schema_validation_failed attempt=${attempt} ` +
        `error=${parsed.error}`,
    );

    if (attempt === MAX_RETRIES_ON_VALIDATION) {
      throw new RebuildCritiqueValidationError(
        `Rebuild critique failed schema validation: ${parsed.error}`,
        text,
      );
    }
  }

  throw new LlmValidationError("rebuild critique unreachable", lastRaw);
}

/**
 * Strict parse: strips an optional Markdown fence the model
 * sometimes adds despite instructions, JSON.parses, and validates
 * against the zod schema. Returns `{ ok: true, value }` or
 * `{ ok: false, error }` — does NOT throw.
 *
 * Exported so unit tests can pin the parse behaviour without an
 * LLM round-trip.
 */
export function parseAndValidate(raw: string): CritiqueResponse {
  const result = tryParseValidated(raw);
  if (result.ok) return result.value;
  throw new RebuildCritiqueValidationError(result.error, raw);
}

interface ParseOk {
  ok: true;
  value: CritiqueResponse;
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
  // model added prose around it ("Here's the critique:\n\n{...}\n\n
  // Hope that helps!"). We slice from the first `{` to the last
  // `}` — JSON objects can contain `{` / `}` inside strings, but
  // the LAST `}` always closes the outermost object as long as
  // the response contains exactly one top-level JSON object,
  // which the prompt requires. Cheaper and more forgiving than a
  // full bracket-balance parse, and the schema validator catches
  // any false positives.
  //
  // We re-slice even when the response starts with `{` to catch
  // the trailing-prose case ("{...}\n\nLet me know if you'd like
  // me to expand."). Skipping the re-slice when there's no prose
  // is a no-op (start=0, end=length-1).
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

  const result = critiqueResponseSchema.safeParse(parsed);
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
