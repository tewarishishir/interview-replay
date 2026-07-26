import "server-only";

import { z } from "zod";

import { features } from "@/lib/env";
import { getLlmClient, LLM_MODEL_SMALL, LlmNotConfiguredError } from "@/lib/llm";
import type { StoryRebuild } from "@/lib/db/schema";

import type { CritiqueResponse } from "./schemas";

/**
 * LLM runner for the "Apply suggestions to my draft" feature.
 *
 * Takes the candidate's current STAR draft + the latest critique
 * and asks the LLM to rewrite each STAR field by applying the
 * critique's actionable suggestions. No profile context is needed
 * here — the critique already synthesized profile-grounded
 * feedback into its dimension cards.
 *
 * Unlike `runCritique` there is NO fallback path: if the model
 * fails to produce valid JSON after one retry we throw
 * `EnhanceValidationError` and let the route return a 502 the
 * user can retry. A synthetic enhanced draft would be misleading
 * (the user pressed "Apply" expecting their specific critique
 * suggestions applied, not a placeholder).
 *
 * Cost: same as critique (~$0.005 at Haiku 4.5 prices).
 */

export const ENHANCE_PROMPT_VERSION = "2026-05-30.v1" as const;

export class EnhanceValidationError extends Error {
  readonly code = "llm_enhance_validation_failed";
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "EnhanceValidationError";
  }
}

/* ────────────────────────────────────────────────────────────── */
/* Output schema                                                   */
/* ────────────────────────────────────────────────────────────── */

const TEXT_MAX = 2000;

/**
 * Lenient wrapper: coerce null/empty-string to null for the
 * optional what_i_would_change field (failure themes only).
 */
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

const truncatingField = z.preprocess(
  (v) => (typeof v === "string" && v.length > TEXT_MAX ? v.slice(0, TEXT_MAX) : v),
  z.string().min(1).max(TEXT_MAX),
);

const enhancedDraftSchema = z.object({
  situation: truncatingField,
  task: truncatingField,
  action: truncatingField,
  result: truncatingField,
  what_i_would_change: lenientOptionalField,
});

export type EnhancedDraft = z.infer<typeof enhancedDraftSchema>;

/* ────────────────────────────────────────────────────────────── */
/* Prompts                                                         */
/* ────────────────────────────────────────────────────────────── */

const ENHANCE_SYSTEM_PROMPT = `You are an interview-coaching assistant. Your only job is to rewrite a candidate's STAR-format draft by applying the specific improvement suggestions from a critique they received.

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
  "what_i_would_change": "<rewritten what_i_would_change field, or null if not applicable>"
}`;

function renderEnhanceUserPrompt(args: {
  situation: string;
  task: string;
  action: string;
  result: string;
  whatIWouldChange: string | null;
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

  lines.push("", "CURRENT DRAFT:", `SITUATION:\n${args.situation}`);
  lines.push(`TASK:\n${args.task}`);
  lines.push(`ACTION:\n${args.action}`);
  lines.push(`RESULT:\n${args.result}`);

  if (args.whatIWouldChange) {
    lines.push(`WHAT I'D DO DIFFERENTLY:\n${args.whatIWouldChange}`);
  }

  lines.push(
    "",
    "Rewrite the draft applying the critique suggestions above. Output JSON only.",
  );

  return lines.join("\n");
}

/* ────────────────────────────────────────────────────────────── */
/* Public surface                                                  */
/* ────────────────────────────────────────────────────────────── */

export interface RunEnhanceArgs {
  rebuild: StoryRebuild;
}

export interface RunEnhanceResult {
  enhanced: EnhancedDraft;
  modelVersion: string;
  promptVersion: string;
}

/**
 * Run the enhance pipeline for a single rebuild.
 *
 * Throws:
 *   - `LlmNotConfiguredError` when no LLM backend is configured
 *     (CI / environments without credentials).
 *   - `EnhanceValidationError` when the model returns non-parseable
 *     JSON after one retry. The caller (route) maps this to 502.
 *
 * NOTE: unlike runCritique, there are no guardrails here. The
 * output is a rewrite of the user's own draft — not a profile-
 * grounded generation — so citation-verbatim guardrails don't
 * apply and a fallback would produce meaningless output.
 */
export async function runEnhance(
  args: RunEnhanceArgs,
): Promise<RunEnhanceResult> {
  if (!features.llmAnalysis) {
    throw new LlmNotConfiguredError();
  }

  const { rebuild } = args;
  const critique = rebuild.aiCritiqueJson as CritiqueResponse | null;
  if (!critique) {
    throw new Error("runEnhance: rebuild has no critique to apply.");
  }

  const client = getLlmClient();

  const userPrompt = renderEnhanceUserPrompt({
    situation: rebuild.situation ?? "",
    task: rebuild.task ?? "",
    action: rebuild.action ?? "",
    result: rebuild.result ?? "",
    whatIWouldChange: rebuild.whatIWouldChange ?? null,
    critique,
  });

  async function callModel(retryMessage?: string): Promise<string> {
    const messages: { role: "system" | "user"; content: string }[] = [
      { role: "system", content: ENHANCE_SYSTEM_PROMPT },
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
      throw new EnhanceValidationError(
        "Enhance: model returned no text content.",
        "",
      );
    }
    return text;
  }

  function tryParse(raw: string): EnhancedDraft | null {
    try {
      let jsonStr = raw;
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch?.[1]) {
        jsonStr = fenceMatch[1];
      } else {
        const objMatch = raw.match(/\{[\s\S]*\}/);
        if (objMatch) jsonStr = objMatch[0];
      }
      const parsed = JSON.parse(jsonStr);
      const result = enhancedDraftSchema.safeParse(parsed);
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
      promptVersion: ENHANCE_PROMPT_VERSION,
    };
  }

  // Retry with explicit correction prompt
  const raw2 = await callModel(
    "Your previous response was not valid JSON matching the required schema. " +
      "Output ONLY the JSON object with the 5 fields: situation, task, action, result, what_i_would_change.",
  );
  const parsed2 = tryParse(raw2);
  if (parsed2) {
    return {
      enhanced: parsed2,
      modelVersion: LLM_MODEL_SMALL,
      promptVersion: ENHANCE_PROMPT_VERSION,
    };
  }

  throw new EnhanceValidationError(
    "Enhance: model returned invalid JSON after retry.",
    raw2,
  );
}
