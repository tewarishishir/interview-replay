import "server-only";

import { z } from "zod";

import { features } from "@/lib/env";
import { getLlmClient, LLM_MODEL_SMALL, LlmNotConfiguredError } from "@/lib/llm";

import type { CritiqueResponse } from "@/lib/rebuilds/schemas";

/**
 * LLM runner for the Story Bank "Apply suggestions to my draft"
 * feature.
 *
 * Mirrors `src/lib/rebuilds/enhance.ts` but operates on story
 * fields (title + STAR + whatILearned) rather than rebuild rows.
 * No persistence: the route returns the rewritten fields and the
 * client overwrites the form textareas directly.
 *
 * Like the rebuild enhance, there is NO fallback path: if the model
 * fails to produce valid JSON after one retry we throw
 * `StoryEnhanceValidationError` and let the route return 502.
 */

export const STORY_ENHANCE_PROMPT_VERSION = "2026-05-30.v1" as const;

export class StoryEnhanceValidationError extends Error {
  readonly code = "llm_story_enhance_validation_failed";
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "StoryEnhanceValidationError";
  }
}

/* ────────────────────────────────────────────────────────────── */
/* Output schema                                                   */
/* ────────────────────────────────────────────────────────────── */

const TEXT_MAX = 2000;

const truncatingField = z.preprocess(
  (v) => (typeof v === "string" && v.length > TEXT_MAX ? v.slice(0, TEXT_MAX) : v),
  z.string().min(1).max(TEXT_MAX),
);

const lenientOptionalField = z.preprocess(
  (v) => {
    if (v == null) return null;
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (t.length === 0) return null;
    if (t.length > TEXT_MAX) return t.slice(0, TEXT_MAX);
    return v;
  },
  z.union([z.string().min(1).max(TEXT_MAX), z.null()]),
);

const storyEnhancedDraftSchema = z.object({
  situation: truncatingField,
  task: truncatingField,
  action: truncatingField,
  result: truncatingField,
  what_i_learned: lenientOptionalField,
});

export type StoryEnhancedDraft = z.infer<typeof storyEnhancedDraftSchema>;

/* ────────────────────────────────────────────────────────────── */
/* Prompts                                                         */
/* ────────────────────────────────────────────────────────────── */

const STORY_ENHANCE_SYSTEM_PROMPT = `You are an interview-coaching assistant. Your only job is to rewrite a candidate's STAR-format story by applying the specific improvement suggestions from a critique they received.

RULES — follow all of them exactly:
1. Preserve the candidate's voice, first-person perspective, and the core factual story.
2. Apply every actionable suggestion from the critique. Dimensions already rated "strong" should be kept as-is.
3. Every verb must be first person ("I designed", "I led") — never "we" alone.
4. Be concrete and specific. Do not replace real details with vague placeholders like "[metric]" or "[timeframe]".
5. Do not invent facts, metrics, or accomplishments not present in the original draft or implied by the critique suggestions.
6. Do not generate example sentences the candidate could read aloud verbatim in an interview — improve the structure and specificity of THEIR story, not replace it.
7. Keep each field focused — do not pad unnecessarily.
8. Output ONLY valid JSON matching the schema below — no commentary, no markdown code fences, no trailing text.

Output schema (JSON only):
{
  "situation": "<rewritten situation field>",
  "task": "<rewritten task field>",
  "action": "<rewritten action field>",
  "result": "<rewritten result field>",
  "what_i_learned": "<rewritten what_i_learned field, or null if not applicable>"
}`;

function renderStoryEnhanceUserPrompt(args: {
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  whatILearned: string;
  critique: CritiqueResponse;
}): string {
  const lines: string[] = [
    "CRITIQUE:",
    `Overall assessment: ${args.critique.overall_assessment}`,
    `Next step: ${args.critique.next_step_suggestion}`,
    "",
    "Dimension feedback:",
  ];

  for (const d of args.critique.dimension_feedback) {
    lines.push(`  • ${d.dimension} [${d.status}]: ${d.what_to_check}`);
  }

  lines.push("", "CURRENT STORY:");
  if (args.title) lines.push(`TITLE:\n${args.title}`);
  lines.push(`SITUATION:\n${args.situation}`);
  lines.push(`TASK:\n${args.task}`);
  lines.push(`ACTION:\n${args.action}`);
  lines.push(`RESULT:\n${args.result}`);
  if (args.whatILearned) {
    lines.push(`WHAT I LEARNED:\n${args.whatILearned}`);
  }

  lines.push(
    "",
    "Rewrite the story applying the critique suggestions above. Output JSON only.",
  );

  return lines.join("\n");
}

/* ────────────────────────────────────────────────────────────── */
/* Public surface                                                  */
/* ────────────────────────────────────────────────────────────── */

export interface StoryEnhanceDraft {
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  whatILearned: string;
}

export interface RunStoryEnhanceArgs {
  draft: StoryEnhanceDraft;
  critique: CritiqueResponse;
}

export interface RunStoryEnhanceResult {
  enhanced: StoryEnhancedDraft;
  modelVersion: string;
  promptVersion: string;
}

/**
 * Run the enhance pipeline for a story-bank draft.
 *
 * Throws:
 *   - `LlmNotConfiguredError` when no LLM backend is configured
 *     (CI / environments without credentials).
 *   - `StoryEnhanceValidationError` when the model returns
 *     non-parseable JSON after one retry. The caller maps this
 *     to 502.
 */
export async function runStoryEnhance(
  args: RunStoryEnhanceArgs,
): Promise<RunStoryEnhanceResult> {
  if (!features.llmAnalysis) {
    throw new LlmNotConfiguredError();
  }

  const { draft, critique } = args;
  const client = getLlmClient();

  const userPrompt = renderStoryEnhanceUserPrompt({
    title: draft.title,
    situation: draft.situation,
    task: draft.task,
    action: draft.action,
    result: draft.result,
    whatILearned: draft.whatILearned,
    critique,
  });

  async function callModel(retryMessage?: string): Promise<string> {
    const messages: { role: "system" | "user"; content: string }[] = [
      { role: "system", content: STORY_ENHANCE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];
    if (retryMessage) {
      messages.push({ role: "user", content: retryMessage });
    }

    const response = await client.chat.completions.create({
      model: LLM_MODEL_SMALL,
      max_tokens: 2048,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages,
    });

    const text = (response.choices[0]?.message?.content || "").trim();
    if (!text) {
      throw new StoryEnhanceValidationError(
        "StoryEnhance: model returned no text content.",
        "",
      );
    }
    return text;
  }

  function tryParse(raw: string): StoryEnhancedDraft | null {
    try {
      let jsonStr = raw;
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch && fenceMatch[1]) {
        jsonStr = fenceMatch[1];
      } else {
        const objMatch = raw.match(/\{[\s\S]*\}/);
        if (objMatch) jsonStr = objMatch[0];
      }
      const parsed = JSON.parse(jsonStr);
      const result = storyEnhancedDraftSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  // First attempt
  const raw1 = await callModel();
  const parsed1 = tryParse(raw1);
  if (parsed1) {
    return {
      enhanced: parsed1,
      modelVersion: LLM_MODEL_SMALL,
      promptVersion: STORY_ENHANCE_PROMPT_VERSION,
    };
  }

  // Retry with explicit correction prompt
  const raw2 = await callModel(
    "Your previous response was not valid JSON matching the required schema. " +
      "Output ONLY the JSON object with the 5 fields: situation, task, action, result, what_i_learned.",
  );
  const parsed2 = tryParse(raw2);
  if (parsed2) {
    return {
      enhanced: parsed2,
      modelVersion: LLM_MODEL_SMALL,
      promptVersion: STORY_ENHANCE_PROMPT_VERSION,
    };
  }

  throw new StoryEnhanceValidationError(
    "StoryEnhance: model returned invalid JSON after retry.",
    raw2,
  );
}
