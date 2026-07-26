import "server-only";

import { features } from "@/lib/env";
import {
  getLlmClient,
  LLM_MODEL_SMALL,
  LlmNotConfiguredError,
  LlmValidationError,
} from "@/lib/llm";
import {
  GUARDRAIL_EVENTS,
  buildFallbackCritique,
  runGuardrails,
  type GuardrailFailure,
} from "@/lib/rebuilds/guardrails";
import {
  loadRebuildProfileContext,
  renderProfileContext,
  type RebuildProfileContext,
} from "@/lib/rebuilds/profile-context";
import {
  critiqueResponseSchema,
  type CritiqueResponse,
  type DimensionFeedback,
} from "@/lib/rebuilds/schemas";

import {
  STORY_CRITIQUE_PROMPT_VERSION,
  STORY_CRITIQUE_SYSTEM_PROMPT,
  renderStoryCritiqueUserPrompt,
} from "./critique-prompt";

/**
 * LLM runner for the story-bank critique surface
 * (`POST /api/stories/critique`).
 *
 * Structural mirror of `runCritique` in
 * `lib/rebuilds/critique.ts` but adapted for the stateless
 * story-bank surface:
 *
 *   - No `StoryRebuild` row — accepts raw draft fields instead.
 *   - No `whatIWouldChange` / `behavioral_change` dimension —
 *     story-bank stories don't carry a failure-question context.
 *   - Profile context is loaded without a question theme (all
 *     stories are passed to the model for cross-reference).
 *   - Same six post-LLM guardrails, same synthetic fallback shape,
 *     same retry-on-schema-failure pattern.
 *
 * The runner is intentionally side-effect-free — no DB writes.
 * The route handler is responsible for persistence.
 */

/* ────────────────────────────────────────────────────────────── */
/* Public surface                                                  */
/* ────────────────────────────────────────────────────────────── */

export class StoryCritiquePreflightError extends Error {
  readonly code: "missing_required_fields";
  readonly missing: ReadonlyArray<string>;
  constructor(missing: ReadonlyArray<string>) {
    super(
      `Story critique preflight failed: missing required draft fields ${missing.join(", ")}`,
    );
    this.name = "StoryCritiquePreflightError";
    this.code = "missing_required_fields";
    this.missing = missing;
  }
}

export class StoryCritiqueValidationError extends Error {
  readonly code = "llm_validation_failed";
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "StoryCritiqueValidationError";
  }
}

export interface StoryCritiqueDraft {
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  whatILearned: string;
}

export interface RunStoryCritiqueResult {
  critique: CritiqueResponse;
  passedGuardrails: boolean;
  guardrailFailures: ReadonlyArray<GuardrailFailure>;
  modelVersion: string;
  promptVersion: string;
}

export interface RunStoryCritiqueArgs {
  userId: string;
  draft: StoryCritiqueDraft;
  /**
   * Optionally pass a pre-resolved profile context so unit tests
   * can stub it without a DB hit. Falls back to
   * `loadRebuildProfileContext` when omitted.
   */
  profile?: RebuildProfileContext;
}

/**
 * Run a story-bank critique end-to-end. Throws:
 *   - `StoryCritiquePreflightError` when the draft lacks situation,
 *     action, or result. The route maps this to a 400.
 *   - `LlmNotConfiguredError` in dev without a configured LLM
 *     backend. The route maps this to 503.
 *
 * Does NOT throw `StoryCritiqueValidationError` — if the model
 * returns unparseable JSON after a retry, we return a synthetic
 * structural fallback with `passedGuardrails: false` so the user
 * always sees something actionable.
 */
export async function runStoryCritique(
  args: RunStoryCritiqueArgs,
): Promise<RunStoryCritiqueResult> {
  preflightDraft(args.draft);

  const profile =
    args.profile ??
    (await loadRebuildProfileContext({
      userId: args.userId,
      // No question theme — include all stories in the profile
      // context for cross-story leverage and consistency checks.
      theme: null,
    }));

  const profileBlock = renderProfileContext(profile, { theme: null });

  const userPrompt = renderStoryCritiqueUserPrompt({
    profileContextBlock: profileBlock,
    title: args.draft.title,
    draft: {
      situation: args.draft.situation,
      task: args.draft.task,
      action: args.draft.action,
      result: args.draft.result,
      whatILearned: args.draft.whatILearned,
    },
  });

  let raw: string;
  try {
    raw = await callLlm({ profileBlock, userPrompt });
  } catch (err) {
    if (err instanceof StoryCritiqueValidationError) {
      return buildSyntheticValidationFallback({
        draft: args.draft,
        reason: err.message,
      });
    }
    throw err;
  }

  let parsed: CritiqueResponse;
  try {
    parsed = parseAndValidate(raw);
  } catch (err) {
    const reason =
      err instanceof StoryCritiqueValidationError ? err.message : "validation_drift";
    return buildSyntheticValidationFallback({ draft: args.draft, reason });
  }

  const guardrailResult = runGuardrails({ critique: parsed, profile });

  if (guardrailResult.ok) {
    return {
      critique: parsed,
      passedGuardrails: true,
      guardrailFailures: [],
      modelVersion: LLM_MODEL_SMALL,
      promptVersion: STORY_CRITIQUE_PROMPT_VERSION,
    };
  }

  const fallback = buildFallbackCritique({
    original: parsed,
    failures: guardrailResult.failures,
  });

  return {
    critique: fallback,
    passedGuardrails: false,
    guardrailFailures: guardrailResult.failures,
    modelVersion: LLM_MODEL_SMALL,
    promptVersion: STORY_CRITIQUE_PROMPT_VERSION,
  };
}

/* ────────────────────────────────────────────────────────────── */
/* Preflight                                                       */
/* ────────────────────────────────────────────────────────────── */

function preflightDraft(draft: StoryCritiqueDraft): void {
  const missing: string[] = [];
  if (!draft.situation.trim()) missing.push("situation");
  if (!draft.action.trim()) missing.push("action");
  if (!draft.result.trim()) missing.push("result");
  if (missing.length > 0) {
    throw new StoryCritiquePreflightError(missing);
  }
}

/* ────────────────────────────────────────────────────────────── */
/* Synthetic fallback when the LLM returns unparseable JSON        */
/* ────────────────────────────────────────────────────────────── */

function buildSyntheticValidationFallback(args: {
  draft: StoryCritiqueDraft;
  reason: string;
}): RunStoryCritiqueResult {
  const failure: GuardrailFailure = {
    event: GUARDRAIL_EVENTS.exampleSentence,
    reason: `LLM validation fallback (story critique): ${args.reason}`,
  };

  const dimensions: DimensionFeedback[] = [
    {
      dimension: "headline",
      status: args.draft.title.trim() ? "needs_work" : "missing",
      quoted_excerpt: args.draft.title,
      what_to_check:
        "Re-read your title. Does it state the OUTCOME of the story, not just the topic?",
    },
    {
      dimension: "star_completeness",
      status:
        args.draft.situation.trim() &&
        args.draft.task.trim() &&
        args.draft.action.trim() &&
        args.draft.result.trim()
          ? "needs_work"
          : "missing",
      quoted_excerpt: "",
      what_to_check:
        "Check that Situation, Task, Action, and Result are each at least 2-3 sentences.",
    },
    {
      dimension: "first_person",
      status: "needs_work",
      quoted_excerpt: "",
      what_to_check:
        "Re-read your Task and Action. Are you using \"I\" (your decision, your work) instead of \"we\"?",
    },
    {
      dimension: "quantification",
      status: args.draft.result.trim() ? "needs_work" : "missing",
      quoted_excerpt: args.draft.result,
      what_to_check:
        "Add at least one number to your Result — percentage change, time saved, headcount, revenue, anything measurable.",
    },
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
  ];

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
    promptVersion: STORY_CRITIQUE_PROMPT_VERSION,
  };
}

/* ────────────────────────────────────────────────────────────── */
/* LLM transport                                                   */
/* ────────────────────────────────────────────────────────────── */

const MAX_RETRIES_ON_VALIDATION = 1;
const MAX_OUTPUT_TOKENS = 4096;

async function callLlm(args: {
  profileBlock: string;
  userPrompt: string;
}): Promise<string> {
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
        { role: "system", content: STORY_CRITIQUE_SYSTEM_PROMPT },
        { role: "user", content: userMessageText },
      ],
    });

    const text = (response.choices[0]?.message?.content || "").trim();

    lastRaw = text;

    if (response.choices[0]?.finish_reason === "length") {
      throw new StoryCritiqueValidationError(
        `Story critique truncated at max_tokens cap (${MAX_OUTPUT_TOKENS}).`,
        text,
      );
    }

    const parsed = tryParseValidated(text);
    if (parsed.ok) return text;

    if (attempt === MAX_RETRIES_ON_VALIDATION) {
      throw new StoryCritiqueValidationError(
        `Story critique failed schema validation: ${parsed.error}`,
        text,
      );
    }
  }

  throw new LlmValidationError("story critique unreachable", lastRaw);
}

function parseAndValidate(raw: string): CritiqueResponse {
  const result = tryParseValidated(raw);
  if (result.ok) return result.value;
  throw new StoryCritiqueValidationError(result.error, raw);
}

function tryParseValidated(raw: string): { ok: true; value: CritiqueResponse } | { ok: false; error: string } {
  let stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

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
