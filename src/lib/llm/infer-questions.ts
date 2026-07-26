import "server-only";

import OpenAI from "openai";
import { z } from "zod";

import { env, features } from "@/lib/env";

import { LlmNotConfiguredError, LlmValidationError, LLM_MODEL_SMALL } from "./client";

/**
 * Lightweight inference pass that runs at the END of `transcribe-session`,
 * BEFORE the candidate enters review mode. The goal is to identify
 * distinct answer chunks in a candidate-only transcript and guess
 * the most likely interview question that prompted each one.
 *
 * Why this lives here, not in `analyze-session`:
 *   - The review screen surfaces high-confidence inferences to the
 *     user as "did the interviewer ask this?" cards. The UX explicitly
 *     wants the candidate to confirm/edit/dismiss BEFORE we run the
 *     full coaching analysis, so the data has to exist by the time
 *     the candidate lands on `/sessions/[id]/review`.
 *   - Cost is the practical reason we keep this separate from the
 *     full analyze pass: at small-model inference cost it's pennies even for
 *     long sessions, and a separate, cheaper call lets us surface
 *     inferences immediately without paying a full report price.
 *
 * Why ONLY high/medium are returned (not low):
 *   - The product spec demands we never surface low-confidence
 *     guesses as cards in the review UI. They risk creating
 *     "phantom-memory" contamination ("oh yeah, the interviewer DID
 *     ask that, didn't they?"). Asking the model to filter at the
 *     boundary saves prompt tokens AND removes the temptation to
 *     ever render them in the UI by mistake.
 *
 * Behaviour on failure:
 *   - This pass is BEST-EFFORT. If the LLM throws or the response
 *     fails to validate, we return an empty array — the transcript
 *     is still useful, the candidate just doesn't get inferred
 *     question cards. We deliberately do NOT propagate the error
 *     out of the worker step; failure to infer should never make
 *     the candidate's transcript unreviewable.
 */

/**
 * Inference model. Uses the small/fast model variant from the
 * environment (defaulting to `LLM_MODEL_SMALL` from `client.ts`).
 * Exported as `HAIKU_MODEL` for backward compatibility with callers
 * that import by that name.
 */
export const HAIKU_MODEL = LLM_MODEL_SMALL;

/**
 * Hard cap on the inference output token budget. Even a 60-minute
 * session generates at most ~30 distinct answer chunks; 2k tokens
 * is comfortable headroom for the JSON shape (question text +
 * confidence + two integers per chunk).
 */
const MAX_INFERENCE_TOKENS = 2048;

/**
 * Cap the transcript fed into the small model at the same 150k-char ceiling
 * the analyze pass uses for the full transcript body. The inference
 * pass is read-only on the transcript and we don't truncate at the
 * head/tail — we just refuse to run the inference when the input
 * exceeds the cap, falling back to "no inferences" so the analyze
 * pass still has the full transcript to work with later.
 */
export const MAX_INFERENCE_TRANSCRIPT_CHARS = 150_000;

const SYSTEM_PROMPT = [
  "You are an expert interview-coach assistant.",
  "",
  "You will be given a transcript of a candidate speaking during a job interview",
  "(or a candidate recapping/practicing answers). ONLY the candidate's voice is",
  "captured — the interviewer's words were redacted before this prompt.",
  "",
  "Your task: identify distinct answer chunks in the transcript and infer the",
  "most likely interview question that prompted each chunk. Even when the",
  "candidate is recapping or practicing, infer the question they were responding",
  "to (e.g. a self-introduction recap implies 'Tell me about yourself.').",
  "",
  "Be GENEROUS in extraction: it is better to surface 4-6 plausible questions",
  "the candidate can quickly confirm or dismiss than to surface zero. The",
  "candidate is the gate — they will accept or reject every suggestion.",
  "",
  "Output rules:",
  "- Return ONLY a JSON array. No prose, no Markdown fencing.",
  "- Each element MUST have exactly these keys:",
  "    inferred_question  — string, max 280 characters",
  "    confidence         — one of 'high' | 'medium' | 'low'",
  "    transcript_offset  — non-negative integer character offset into the transcript",
  "    transcript_length  — positive integer character length of the answer chunk",
  "- Use 'high' when the question is essentially recoverable from the answer",
  "  (the candidate explicitly references it, restates it, or the answer is a",
  "  classic well-known prompt like 'Tell me about yourself.', 'Why <company>?',",
  "  or 'Tell me about a time you …').",
  "- Use 'medium' for plausible guesses where multiple framings are possible.",
  "- Use 'low' for weak guesses you would not stake your name on. The candidate",
  "  sees EVERY guess (with its confidence band displayed) and decides whether",
  "  to confirm or dismiss it themselves — your job is to surface options, not",
  "  to filter for them. When in doubt, emit the low-confidence row rather",
  "  than dropping the chunk entirely.",
  "- Offsets MUST be valid: transcript_offset + transcript_length <= len(transcript).",
  "- Do NOT overlap chunks. Each character of the transcript should belong to at",
  "  most one chunk. Skip filler/silence between chunks.",
  "- Inferred questions should sound like real interview prompts, not summaries",
  "  of the answer. Prefer the form an interviewer would actually use.",
  "- Never include the candidate's name or PII in the inferred question.",
].join("\n");

/**
 * Schema for a single inference row.
 *
 * `confidence` accepts ALL three bands (high/medium/low). All three
 * are surfaced to the candidate as suggestion cards (with their
 * band displayed) — the candidate is the gate, NOT us. The
 * historical version of this file rejected 'low' at the schema
 * boundary, which had two failure modes:
 *   1. A single stray 'low' row caused Zod to reject the entire
 *      response, dropping every other (high/medium) suggestion in
 *      the same batch.
 *   2. Even when 'low' didn't blow up the parse, hiding low-confidence
 *      guesses removed potentially-useful prompts from the candidate's
 *      view. The product wants the candidate to decide.
 *
 * The same per-batch-failure pattern lurks for ANY validation
 * issue (oversized question, missing field, garbage offset). The
 * fix isn't to make every constraint lenient — it's to validate
 * per item in `parseAndValidate` so a single bad row gets dropped
 * instead of poisoning the whole batch.
 */
const inferenceItemSchema = z.object({
  inferred_question: z.string().trim().min(1).max(280),
  confidence: z.enum(["high", "medium", "low"]),
  transcript_offset: z.number().int().nonnegative(),
  transcript_length: z.number().int().positive(),
});

export type InferenceItem = z.infer<typeof inferenceItemSchema>;

/**
 * Hard cap on the number of inferences we'll keep from a single
 * LLM response. The model is told to stay well under this; the
 * cap exists so an adversarial / pathological response can't
 * balloon the artifact-write transaction.
 *
 * 50 is generous: a 60-minute interview rarely contains more than
 * 30 distinct answer chunks. We slice (not throw) when the model
 * exceeds it — the alternative is dropping every inference for
 * sessions that happened to land 51 rows.
 */
export const MAX_INFERENCE_ITEMS = 50;

export interface InferQuestionsArgs {
  transcript: string;
}

let cachedClient: OpenAI | null = null;
function getLlmClient(): OpenAI {
  if (cachedClient) return cachedClient;
  if (!features.llmAnalysis) throw new LlmNotConfiguredError();

  const baseURL = env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
  cachedClient = new OpenAI({
    baseURL,
    apiKey: env.LLM_API_KEY || "ollama",
    timeout: 2 * 60 * 1000,
    maxRetries: 1,
  });
  return cachedClient;
}

/**
 * Run the inference pass and return the validated chunks.
 *
 * - Returns an empty array if the transcript is empty / under a
 *   handful of words (nothing to infer from).
 * - Filters out any chunk whose offset+length escapes the transcript
 *   even after the model's own validation — defensive against the
 *   model hallucinating offsets in long inputs.
 * - The caller is expected to wrap this in a try/catch and fall
 *   through to "no inferences" on any throw — see `runInferencePass`
 *   below for the wrapper used by the worker.
 */
export async function inferQuestions(
  args: InferQuestionsArgs,
): Promise<InferenceItem[]> {
  const transcript = args.transcript ?? "";
  if (transcript.trim().length < 50) return [];
  if (transcript.length > MAX_INFERENCE_TRANSCRIPT_CHARS) return [];

  const client = getLlmClient();

  const response = await client.chat.completions.create({
    model: HAIKU_MODEL,
    max_tokens: MAX_INFERENCE_TOKENS,
    temperature: 0.3,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "Transcript:\n\n" +
          transcript +
          "\n\nReturn the JSON array now. No commentary.",
      },
    ],
  });

  const raw = (response.choices[0]?.message?.content || "").trim();

  return parseAndValidate(raw, transcript.length);
}

/**
 * Locate the JSON payload inside an LLM response. The system
 * prompt tells the model to return ONLY a JSON array but models
 * occasionally add a preamble ("Here are the inferred
 * questions:\n\n[...]"), wraps the array in Markdown fencing, or
 * self-corrects into a `{ "items": [...] }` shape. We strip all
 * three patterns rather than failing the whole inference pass on
 * a cosmetic prose wrapper — those are the cases unit-test
 * fixtures pin below.
 *
 * Exported so unit tests can pin the slice behaviour without an
 * LLM round-trip.
 */
export function extractJsonPayload(raw: string): string {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  if (stripped.length === 0) return stripped;
  if (stripped.startsWith("[") || stripped.startsWith("{")) {
    return stripped;
  }

  // Find the first `[` (preferred) or `{` and slice through the
  // matching closer. We pick the OUTERMOST array if both exist —
  // The model's preamble usually mentions the question count first
  // ("Here are 4 inferred questions:") before the array.
  const firstBracket = stripped.indexOf("[");
  const firstBrace = stripped.indexOf("{");
  let start = -1;
  let openChar = "";
  let closeChar = "";
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    start = firstBracket;
    openChar = "[";
    closeChar = "]";
  } else if (firstBrace !== -1) {
    start = firstBrace;
    openChar = "{";
    closeChar = "}";
  }
  if (start === -1) return stripped;

  // Walk forward, ignoring brackets inside string literals, until
  // the depth returns to zero. This is intentionally a tiny parser
  // (not full JSON) — it just needs to find a balanced close.
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return stripped.slice(start, i + 1);
      }
    }
  }
  return stripped.slice(start);
}

/**
 * Strip optional Markdown fencing, JSON.parse, validate per item,
 * and shape the result for the rest of the pipeline:
 *
 *   1. Validate EACH row with `safeParse` and drop the bad ones
 *      individually — the historical version called `safeParse`
 *      on the whole array, which meant one malformed row (wrong
 *      type, missing field, oversized question, garbage offsets)
 *      poisoned every OTHER inference in the same batch. The
 *      worker swallowed the resulting `LlmValidationError` into
 *      "zero questions" and the candidate saw nothing.
 *   2. Slice to `MAX_INFERENCE_ITEMS` rather than rejecting the
 *      whole batch when the model overshoots the cap.
 *   3. Drop chunks whose (offset, length) doesn't actually fit
 *      inside the transcript — defensive against the model
 *      hallucinating offsets in long inputs.
 *   4. Sort by offset and drop overlaps so the review UI can
 *      render cards top-to-bottom without post-processing.
 *
 * NOTE: 'low' confidence rows are NOT filtered out here — the
 * candidate is the gate (each card displays its confidence band
 * so the candidate can quickly judge before confirming/dismissing).
 *
 * Throws `LlmValidationError` only when the OUTER shape is broken
 * (not valid JSON, not an array even after looking for common
 * wrappers). A response that contains some bad rows mixed with
 * good ones is NOT a fatal error.
 *
 * Exported so unit tests can pin the parsing behaviour without an
 * LLM round-trip.
 */
export function parseAndValidate(
  raw: string,
  transcriptLength: number,
): InferenceItem[] {
  const payload = extractJsonPayload(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    throw new LlmValidationError(
      `inference: not valid JSON: ${(err as Error).message}`,
      raw,
    );
  }

  // The model occasionally wraps the array in `{ "items": [...] }`
  // (or `{ "questions": [...] }`, `{ "results": [...] }`) when its
  // self-correcting kicks in. Accept any of the common shapes.
  let candidate: unknown = parsed;
  if (!Array.isArray(parsed) && parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    candidate =
      obj.items ?? obj.questions ?? obj.results ?? obj.inferences ?? parsed;
  }

  if (!Array.isArray(candidate)) {
    throw new LlmValidationError(
      `inference: expected an array (or {items|questions|results|inferences: [...]}) but got ${typeof candidate}`,
      raw,
    );
  }

  // Per-item validation. A malformed row gets dropped; the rest
  // survive. We cap the input at 2× MAX_INFERENCE_ITEMS first so
  // a runaway response can't make us run safeParse 10,000 times.
  const sliced = candidate.slice(0, MAX_INFERENCE_ITEMS * 2);
  const validated: InferenceItem[] = [];
  for (const row of sliced) {
    const itemResult = inferenceItemSchema.safeParse(row);
    if (!itemResult.success) continue;
    const item = itemResult.data;
    // Defensive bounds check on top of the schema's `nonnegative`
    // / `positive` constraints. The schema can't know the
    // transcript length so this is the layer that drops chunks
    // whose (offset, length) escapes the actual buffer.
    if (item.transcript_offset + item.transcript_length > transcriptLength) {
      continue;
    }
    validated.push(item);
    if (validated.length >= MAX_INFERENCE_ITEMS) break;
  }

  // Sort by offset so the review UI can render cards top-to-bottom
  // without re-sorting on every render.
  validated.sort((a, b) => a.transcript_offset - b.transcript_offset);

  // Drop overlapping chunks — keep the first, drop the second. The
  // model is instructed not to overlap but we don't trust the
  // instruction blindly. A future "merge overlaps" pass could be
  // smarter; for now, the cheap thing is correct enough.
  const nonOverlapping: InferenceItem[] = [];
  let lastEnd = -1;
  for (const item of validated) {
    if (item.transcript_offset < lastEnd) continue;
    nonOverlapping.push(item);
    lastEnd = item.transcript_offset + item.transcript_length;
  }

  return nonOverlapping;
}

/**
 * Worker-friendly wrapper that swallows ANY error and returns an
 * empty array. Use this from `transcribe-session` so an inference
 * failure can never make the transcript unreviewable.
 *
 * Failures are emitted via `console.warn` so a production worker
 * surfaces them in logs without bringing down the transcribe
 * pipeline. (Unit tests that exercise the error path can mute
 * `console.warn` if the noise is undesirable.) Successful runs
 * with zero items are also worth logging — the most common
 * "LLM is being called but no questions show up" report turns
 * out to be a successful call that genuinely returned an empty
 * array because the transcript was too short, all rows were
 * 'low' confidence, or every (offset, length) escaped the
 * transcript bounds.
 */
export async function runInferencePass(
  args: InferQuestionsArgs,
): Promise<{
  items: InferenceItem[];
  error: string | null;
}> {
  if (!features.llmAnalysis) {
    // Dev path: no LLM configured, no inferences. The candidate
    // proceeds to review with zero AI cards, which matches the
    // pre-inference behaviour and keeps the rest of the flow
    // exercisable without burning tokens.
    return { items: [], error: null };
  }

  try {
    const items = await inferQuestions(args);
    if (items.length === 0) {
      console.warn(
        "[infer-questions] LLM returned zero usable inferences " +
          `(transcript chars=${args.transcript?.length ?? 0}). ` +
          "Common causes: very short candidate-only audio, all rows " +
          "filtered as 'low' confidence, or all offsets out of bounds.",
      );
    }
    return { items, error: null };
  } catch (err) {
    const message =
      err instanceof Error ? `${err.name}: ${err.message}` : "inference_failed";
    console.warn("[infer-questions] inference failed:", message);
    return { items: [], error: message };
  }
}
