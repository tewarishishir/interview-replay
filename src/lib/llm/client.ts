import "server-only";

import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";

import { env, features } from "@/lib/env";
import type {
  Artifact,
  InterviewLevel,
  InterviewRoundType,
  InterviewSession,
  Transcript,
} from "@/lib/db/schema";

import { findForbiddenLanguage } from "./forbidden";
import { SYSTEM_PROMPT } from "./prompt";
import {
  analyticsOutputSchema,
  storyHighlightsOutputSchema,
  perQuestionAnalyticsSchema,
  reportSchema,
  type AnalyticsOutput,
  type StoryHighlightsOutput,
  type Report,
} from "./schema";
import { rubricFor, RUBRIC_VERSION } from "./rubrics";

/**
 * Model selection via env vars with sensible Ollama defaults.
 * The large model handles the main analysis pass; the small model
 * handles lighter tasks (question inference, etc.).
 *
 * Override with `LLM_MODEL_LARGE` / `LLM_MODEL_SMALL` env vars
 * to swap models without a code change.
 */
export const LLM_MODEL_LARGE = (env.LLM_MODEL_LARGE || "llama3.3:70b") as string;
export const LLM_MODEL_SMALL = (env.LLM_MODEL_SMALL || "llama3.3:8b") as string;

/** @deprecated Use `LLM_MODEL_LARGE` — kept for backward compatibility. */


/**
 * Per-round token budgets for the LEGACY full-report call (single LLM call
 * covering all sections including questionsCovered and per_question_analytics).
 * Used only by `generateReport()` in its backward-compatible "full" mode —
 * the parallel split path uses CORE_MAX_TOKENS_BY_ROUND and
 * ANALYTICS_MAX_TOKENS_BY_ROUND instead.
 *
 * These ceilings have to fit the FULL report shape — executiveSummary,
 * up to 4 strengths and ~6 improvements (each with multi-quote evidence),
 * `communicationSignals`, the per-round `roundSpecific` block, the boxed
 * `aiRead` paragraph + `readinessScore`, AND the load-bearing
 * `questionsCovered` array (up to 30 entries, each with a 500-char
 * `evidenceQuote`).
 */
export const MAX_TOKENS_BY_ROUND: Record<InterviewRoundType, number> = {
  coding: 12_288,
  system_design: 16_384,
  behavioral: 12_288,
  other: 12_288,
};

/**
 * Token budgets for the CORE third of the parallel split: the seven
 * narrative sections EXCLUDING `storyHighlights`, `questionsCovered`,
 * and `per_question_analytics` (those three are now generated
 * concurrently by `generateAnalytics` and `generateStoryHighlights`).
 *
 * Sized for: executiveSummary, strengths, improvements,
 * communicationSignals, roundSpecific, aiRead, plus JSON overhead.
 *
 * 2026-06-06 (history kept for the next reviewer):
 *   - Initial parallel split set behavioral=4 096, which truncated real
 *     interviews. Bumped to 8 192.
 *   - Then split `storyHighlights` into its own parallel call (this
 *     change). The core call's output now excludes the ~800-1 600 tokens
 *     that storyHighlights used to consume, so we can trim the budgets
 *     back down. We keep generous headroom over observed peak narrative
 *     to absorb verbose roundSpecific blocks.
 */
export const CORE_MAX_TOKENS_BY_ROUND: Record<InterviewRoundType, number> = {
  coding: 5_120,
  system_design: 6_144,
  behavioral: 6_144,
  other: 5_120,
};

/**
 * Token budgets for the ANALYTICS third of the parallel split:
 * `questionsCovered` + `per_question_analytics` only.
 *
 * Worst-case output calculation (schema hard caps):
 *   - questionsCovered (max 30): question ≤500 chars + evidenceQuote ≤500 chars
 *     + confidence + source + JSON keys ≈ 290 tokens/entry × 30 = 8 700 tokens
 *   - per_question_analytics (max 30): question_text ≤1 000 chars + duration +
 *     question_type + star_signals + filler_per_minute + i/we counts +
 *     profile_leverage (status + optional UUIDs/labels) + JSON keys
 *     ≈ 400 tokens/entry × 30 = 12 000 tokens
 *   - JSON structure overhead ≈ 500 tokens
 *   Total absolute maximum: ~21 200 tokens
 *
 * We set a uniform 16 384 budget across all round types. This covers:
 *   - Up to ~23 fully-verbose questions (all fields at schema max) — well
 *     above any real interview; typical sessions produce 2 000–6 000 tokens
 *   - Behavioral rounds that surface 20-25 questions (the realistic ceiling)
 *     with full STAR + profile_leverage fields
 *
 * Why uniform rather than per-round:
 *   - The prior per-round budgets caused a silent "Questions tab disappears"
 *     failure for coding sessions (3 072 → 6 144 wasn't enough headroom
 *     because the estimate was wrong). A single generous cap eliminates
 *     the class of bug.
 *   - Most open-weight models support output token counts well above
 *     16 384. Cost impact is zero for sessions that produce fewer
 *     tokens (billing is on actual output, not max_tokens).
 *
 * Do NOT lower this below 16 384 without re-running the absolute worst-case
 * math above and verifying the model supports the new value.
 */
const ANALYTICS_MAX_TOKENS = 16_384;
export const ANALYTICS_MAX_TOKENS_BY_ROUND: Record<InterviewRoundType, number> = {
  coding: ANALYTICS_MAX_TOKENS,
  system_design: ANALYTICS_MAX_TOKENS,
  behavioral: ANALYTICS_MAX_TOKENS,
  other: ANALYTICS_MAX_TOKENS,
};

/**
 * Token budgets for the STORIES third of the parallel split: the
 * `storyHighlights` array only. Sized for up to 6 entries × ~250 tokens
 * (title + body up to 800 chars ≈ 200 tokens, plus JSON wrapper).
 *
 * Behavioral rounds are where this section earns its keep — coding /
 * system_design typically emit `[]` so a smaller budget would do, but
 * the overhead of generating an empty array is trivial so we use the
 * same generous floor everywhere.
 */
export const STORIES_MAX_TOKENS_BY_ROUND: Record<InterviewRoundType, number> = {
  coding: 1_024,
  system_design: 1_024,
  behavioral: 2_048,
  other: 1_024,
};

/**
 * Injected at the end of the user message for the CORE parallel call.
 * Tells the model to skip the sections generated by concurrent calls
 * (questions/analytics + stories) and emit minimal-valid placeholders
 * so the schema parser doesn't error on missing fields.
 */
export const CORE_SCOPE_HINT =
  "PARALLEL CALL SCOPE — core narrative only. " +
  "Generate these 6 fields: executiveSummary, strengths, improvements, " +
  "communicationSignals, roundSpecific, aiRead. " +
  "Return \"questionsCovered\": [] and \"storyHighlights\": [] (empty " +
  "arrays) and DO NOT include per_question_analytics. Question " +
  "extraction and story highlights run in concurrent calls.";

/**
 * Injected at the end of the user message for the ANALYTICS parallel call.
 * Tells the model to skip the narrative sections and focus only on
 * question extraction and per-question analytics.
 */
export const ANALYTICS_SCOPE_HINT =
  "PARALLEL CALL SCOPE — analytics only. " +
  "The core narrative report is being generated concurrently. " +
  "Generate ONLY these 2 top-level fields: questionsCovered and " +
  "per_question_analytics. Apply all rules from the system prompt for " +
  "those two fields. Return a JSON object with ONLY those 2 keys — " +
  "do NOT generate executiveSummary, strengths, improvements, " +
  "communicationSignals, roundSpecific, aiRead, or storyHighlights.";

/**
 * Injected at the end of the user message for the STORIES parallel call.
 * Tells the model to skip everything except the `storyHighlights` array
 * — the heaviest single narrative section by output tokens for behavioral
 * rounds, now generated concurrently with the rest.
 */
export const STORIES_SCOPE_HINT =
  "PARALLEL CALL SCOPE — story highlights only. " +
  "The core narrative report and the analytics report are being " +
  "generated concurrently. Generate ONLY the storyHighlights array " +
  "following the rules in the system prompt (`## Story highlights`). " +
  "Return a JSON object with ONLY this key: { \"storyHighlights\": [ ... ] }. " +
  "For coding or system_design rounds where the candidate did not tell " +
  "extended narrative answers, return { \"storyHighlights\": [] }. " +
  "Do NOT generate executiveSummary, strengths, improvements, " +
  "communicationSignals, roundSpecific, aiRead, questionsCovered, " +
  "or per_question_analytics.";

/**
 * Hard input-size cap on the per-session prompt body (transcript +
 * artifacts), measured in characters of the user-message text. The
 * cap is the load-bearing defense against:
 *
 *   - A 120-minute session being charged at most 4 credits but
 *     producing a transcript of ~12-20k words. That fits well under
 *     the cap.
 *   - A pathological / malicious transcript edit that pads the
 *     `editedText` column with megabytes of arbitrary text — without
 *     this cap that would cost us hundreds of thousands of input
 *     tokens at LLM inference cost, for the same fixed credit charge.
 *   - Artifacts (text/markdown) being individually capped by the
 *     upload endpoint, but still totalling more than the prompt
 *     budget when summed.
 *
 * Picked by:
 *   - 120 min @ ~150 wpm @ ~6 char/word ≈ 108k characters of
 *     candidate-only speech. Round to 150k for headroom.
 *   - Adds another 50k of artifact slack (10 artifacts of 5kB).
 *
 * If we trip this cap we truncate the transcript first (preserving
 * the head and tail with an explicit truncation marker so the model
 * knows it's reading a clipped recording), then truncate artifacts
 * round-robin until everything fits.
 */
export const MAX_PROMPT_BODY_CHARS = 200_000;
export const MAX_TRANSCRIPT_BODY_CHARS = 150_000;
export const MAX_ARTIFACT_BODY_CHARS = 50_000;
const TRUNCATION_MARKER =
  "\n\n[... transcript truncated for length; the report should call out that the recording exceeds analysis limits ...]\n\n";

/**
 * Thin-transcript thresholds.
 *
 * If a recording falls below either bound there's not enough
 * material for the LLM to produce an evidence-anchored report;
 * the worker short-circuits to `buildFallbackReport(..., "thin_transcript")`
 * before burning an LLM round-trip. The user sees a clear
 * "your recording was too short" report and gets their credit
 * back instead of the misleading "something went wrong on our
 * end" failed panel.
 *
 * Numbers picked from production data: a real interview answer to
 * even a single question lands around 30-50 words / 15-30 seconds.
 * Anything below 20 words / 15 seconds is almost always a misclick
 * (user hit record, then immediately stopped) and never produces
 * a useful analysis.
 */
export const THIN_TRANSCRIPT_MIN_WORDS = 20;
export const THIN_TRANSCRIPT_MIN_SECONDS = 15;

/**
 * Prefix on `AnalyzeResult.modelVersion` when the report was built
 * locally (not by the LLM). Used by the worker to decide whether to
 * refund the credit after persisting — fallback reports always
 * refund, real LLM reports never do.
 *
 * Exported so the worker, the report renderer, and ops queries can
 * all share the same sentinel without re-deriving it.
 */
export const FALLBACK_MODEL_VERSION_PREFIX = "fallback:" as const;

/**
 * Why a fallback report was generated. Threaded through to the
 * report's `modelVersion` (`fallback:<reason>`) so ops can query
 * the rate of each failure mode without scraping logs.
 */
export type FallbackReason =
  | "thin_transcript"
  | "llm_validation_failed"
  | "llm_unavailable"
  | "llm_error";

/**
 * Returns true when the transcript is too short to support a real
 * evidence-anchored report. The analyze worker checks this BEFORE
 * the LLM call so a 2-second misclick recording doesn't
 * waste an LLM call AND doesn't crash schema validation when the
 * model honestly returns empty strengths/improvements arrays.
 *
 * Two distinct paths, one shared minimum-word bar:
 *
 *   - No `editedText` (the common case — fresh transcription, no
 *     post-recording edits). Both audio-derived bounds apply:
 *     a 200-word transcript that (somehow) only lasted 3 seconds
 *     is just as unusable as a 5-word transcript that lasted 5
 *     minutes.
 *
 *   - `editedText` is present. The candidate has explicitly
 *     supplied the text we should analyze, so the audio duration
 *     is no longer a meaningful bound (e.g. a misclick that
 *     captured 3 seconds of audio but was then edited up to a
 *     53k-character paste of the full conversation must NOT be
 *     gated by `durationSeconds < 15`). We count words in the
 *     edited text directly and apply only the word bound. Without
 *     this branch, a candidate who edits a thin recording to add
 *     real content still gets the "too short" fallback report
 *     even though the analyzer has plenty of material to work
 *     with — the original 2026-05-18 incident.
 */
export function isThinTranscript(t: {
  wordCount: number;
  durationSeconds: number;
  editedText?: string | null;
}): boolean {
  if (t.editedText !== undefined && t.editedText !== null) {
    return countWordsInText(t.editedText) < THIN_TRANSCRIPT_MIN_WORDS;
  }
  return (
    t.wordCount < THIN_TRANSCRIPT_MIN_WORDS ||
    t.durationSeconds < THIN_TRANSCRIPT_MIN_SECONDS
  );
}

/**
 * Whitespace-delimited word count for a free-form text string.
 * Matches the heuristic the transcription pipeline writes into
 * `transcripts.word_count` for the original audio, so the
 * thin-transcript gate is comparing apples to apples whether the
 * source is `wordCount` (audio-derived) or the user's edited text.
 */
function countWordsInText(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

let cachedClient: OpenAI | null = null;
export function getLlmClient(): OpenAI {
  if (cachedClient) return cachedClient;
  if (!features.llmAnalysis) throw new LlmNotConfiguredError();

  const baseURL = env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
  cachedClient = new OpenAI({
    baseURL,
    apiKey: env.LLM_API_KEY || "ollama",
    timeout: 5 * 60 * 1000,
    maxRetries: 1,
  });
  return cachedClient;
}

export class LlmNotConfiguredError extends Error {
  readonly code = "llm_not_configured";
  readonly status = 503;
  constructor() {
    super(
      "LLM is not configured. Ensure Ollama is running at OLLAMA_BASE_URL " +
        "(default: http://localhost:11434) with the configured model pulled.",
    );
    this.name = "LlmNotConfiguredError";
  }
}

export class LlmValidationError extends Error {
  readonly code = "llm_validation_failed";
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "LlmValidationError";
  }
}

export interface AnalyzeArgs {
  session: Pick<
    InterviewSession,
    "companyName" | "roleTitle" | "level" | "roundType"
  >;
  transcript: Pick<
    Transcript,
    "redactedText" | "editedText" | "wordCount" | "durationSeconds" | "fillerWordCount"
  >;
  /**
   * Each artifact carries its provenance fields so the prompt
   * builder can frame AI-inferred (unconfirmed) questions as
   * "best-guess prompts" rather than ground-truth candidate input.
   * `source`, `aiConfidence`, and `userConfirmed` are optional
   * so a caller that doesn't know about provenance (e.g. a future
   * one-off rendering path) still typechecks.
   *
   * `id` is the artifact row's UUID; we surface it in the prompt
   * header so the new `per_question_analytics[i].artifact_id`
   * field has a stable target to copy verbatim. Optional for
   * back-compat with callers that don't load it.
   *
   * `userConfirmed` is a boolean rather than a Date so the value
   * survives JSON serialization intact. (See `AnalysisInputs` in
   * `src/lib/sessions/analyze.ts`.)
   */
  artifacts: Array<
    Pick<Artifact, "artifactType" | "content" | "imageUrl" | "displayOrder"> & {
      id?: string;
      source?: "user_added" | "ai_inferred";
      aiConfidence?: "high" | "medium" | "low" | null;
      userConfirmed?: boolean;
    }
  >;
  /**
   * Optional candidate-profile snapshot the analyze worker splices
   * into the prompt so the model can ground the new
   * `per_question_analytics[i].profile_leverage` field in real
   * profile items (and the post-response guardrails can verify any
   * referenced/suggested UUID against the source profile).
   *
   * Optional so callers that don't yet load profile data (legacy
   * tests, a future one-off rendering path) still typecheck — the
   * model is told elsewhere in the prompt that it must fall back
   * to `status='no_match'` when no profile data is available.
   */
  profile?: {
    /**
     * `projects` rows owned by the candidate. Only the fields the
     * model needs to identify and label an item; we omit
     * timestamps and bookkeeping columns.
     */
    projects: Array<{
      id: string;
      name: string;
      companyContext: string | null;
      timePeriod: string | null;
      myRole: string | null;
      keyDecisions: string | null;
      outcomesWithMetrics: string | null;
    }>;
    /** `stories` rows owned by the candidate (theme bank). */
    stories: Array<{
      id: string;
      theme: string;
      title: string;
      situation: string | null;
      task: string | null;
      action: string | null;
      result: string | null;
    }>;
  };
  /**
   * Optional extra instruction injected after the session context
   * block. Used by the overlap-detection retry in the analyze
   * worker to nudge a fresh call toward differentiating
   * `aiRead` from `executiveSummary` when the first attempt
   * was too similar.
   */
  differentiationHint?: string;
}

export interface AnalyzeResult {
  report: Report;
  modelVersion: string;
  rubricVersion: string;
}

export interface AnalyticsResult {
  questionsCovered: AnalyticsOutput["questionsCovered"];
  per_question_analytics: AnalyticsOutput["per_question_analytics"];
}

export interface StoryHighlightsResult {
  storyHighlights: StoryHighlightsOutput["storyHighlights"];
}

// 4 retries = 5 total attempts. Open-weight models are less reliable at
// producing valid JSON than proprietary models, so we give them more chances. Each
// retry includes the previous bad output in the prompt to guide correction.
const MAX_RETRIES_ON_VALIDATION = 4;

/**
 * Build the user-message body. We split into two text blocks so
 * the model gets a clear separation between the rubric (cacheable)
 * and the per-session payload (not cacheable).
 *
 * Prompt caching: the system prompt + the rubric block are the
 * largest stable parts. The transcript / artifacts block is
 * per-session.
 */
/**
 * Truncate a string to `maxChars` while preserving the head and a
 * tail slice (so a transcript still includes the closing exchange,
 * which often contains the candidate's recap / questions). Inserts
 * an explicit marker between the two halves so the model knows it's
 * reading a clipped recording.
 *
 * Exported so tests can pin the slicing behavior without setting
 * up a full prompt build.
 */
export function clampWithHeadAndTail(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  // Reserve the marker; split the rest 70/30 head:tail so the
  // candidate's opening framing dominates and we still see the wrap.
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  const headChars = Math.floor(budget * 0.7);
  const tailChars = budget - headChars;
  const head = input.slice(0, headChars);
  const tail = tailChars > 0 ? input.slice(-tailChars) : "";
  return head + TRUNCATION_MARKER + tail;
}

/**
 * Round-robin truncate the artifact content blocks until the total
 * size is within `maxChars`. Preserves order and at least one line
 * per artifact (so the model still sees that the artifact existed
 * and what type it is, even if the body got trimmed to a stub).
 */
export function clampArtifactBlocks(
  blocks: Array<{ header: string; body: string }>,
  maxChars: number,
): Array<{ header: string; body: string }> {
  const sized = blocks.map((b) => ({ ...b }));
  let total = sized.reduce(
    (acc, b) => acc + b.header.length + 1 + b.body.length,
    0,
  );
  if (total <= maxChars) return sized;

  // Repeatedly trim the longest block by 10% until we're under
  // budget OR every block is at minimum (header + 1-line stub).
  // This keeps short artifacts intact and only cuts the verbose
  // ones.
  const STUB = "[... artifact truncated ...]";
  let safety = 200;
  while (total > maxChars && safety-- > 0) {
    let longestIdx = -1;
    let longestLen = -1;
    for (let i = 0; i < sized.length; i++) {
      const len = sized[i]!.body.length;
      if (len > longestLen) {
        longestLen = len;
        longestIdx = i;
      }
    }
    if (longestIdx < 0 || longestLen <= STUB.length) break;
    const target = sized[longestIdx]!;
    const newLen = Math.max(STUB.length, Math.floor(target.body.length * 0.9));
    target.body =
      target.body.length > newLen
        ? target.body.slice(0, newLen) + "\n" + STUB
        : STUB;
    total = sized.reduce(
      (acc, b) => acc + b.header.length + 1 + b.body.length,
      0,
    );
  }
  return sized;
}

/**
 * Render a single per-artifact header for the analyze prompt.
 * Exported so tests can pin the wording without going through the
 * full prompt build.
 */
export function buildArtifactHeader(
  index: number,
  artifact: AnalyzeArgs["artifacts"][number],
): string {
  // `artifact_id:` is appended as a second line on the header when
  // the row's UUID is available so the per_question_analytics
  // section can reference it verbatim. We deliberately keep the
  // existing single-line form when `id` isn't supplied so the
  // legacy tests pinning the old wording continue to pass; new
  // analyses always pass an id through.
  const idSuffix = artifact.id ? `\nartifact_id: ${artifact.id}` : "";
  const base = `--- Artifact ${index} (${artifact.artifactType}) ---`;
  if (artifact.source !== "ai_inferred") return base + idSuffix;

  // AI-inferred. Distinguish "candidate confirmed" from "Haiku
  // guess the candidate hasn't acted on" — the analyzer should
  // weight them differently. Confidence band is included for the
  // latter so the model can lean on high-confidence guesses.
  if (artifact.userConfirmed) {
    return `${base} [source: AI-inferred, candidate-confirmed]${idSuffix}`;
  }
  // Fall back to "medium" only when the band is truly missing
  // (legacy rows pre-date the column). Defaulting to medium is
  // honest: the analyzer treats it as "best-guess of unspecified
  // strength", neither over- nor under-trusting the row.
  const conf = artifact.aiConfidence ?? "medium";
  return `${base} [source: AI-inferred best-guess (${conf} confidence), not yet confirmed by candidate]${idSuffix}`;
}

/**
 * Render the candidate profile snapshot the analyze prompt splices
 * in. Format mirrors `lib/rebuilds/profile-context.ts` so the
 * model sees a consistent shape across surfaces; the load-bearing
 * difference here is that we ALWAYS emit the `Project ID:` /
 * `Story ID:` lines so the per_question_analytics section can
 * copy them verbatim into `profile_leverage.referenced_item_id`.
 *
 * Exported so tests can pin the wording without spinning up a
 * full prompt build.
 */
export function buildProfileSnapshot(
  profile: NonNullable<AnalyzeArgs["profile"]>,
): string {
  const lines: string[] = [];
  lines.push("# Candidate profile snapshot");
  lines.push("");
  lines.push(
    "Use ONLY these IDs for per_question_analytics.profile_leverage.",
  );
  lines.push("");

  lines.push("Projects:");
  if (profile.projects.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of profile.projects) {
      lines.push(`  - Project ID: ${p.id}`);
      lines.push(`    Name: ${oneLine(p.name)}`);
      lines.push(`    Company: ${oneLine(p.companyContext)}`);
      lines.push(`    Time period: ${oneLine(p.timePeriod)}`);
      lines.push(`    My role: ${oneLine(p.myRole)}`);
      lines.push(`    Key decisions: ${oneLine(p.keyDecisions)}`);
      lines.push(
        `    Outcomes with metrics: ${oneLine(p.outcomesWithMetrics)}`,
      );
    }
  }
  lines.push("");

  lines.push("Stories:");
  if (profile.stories.length === 0) {
    lines.push("  (none)");
  } else {
    for (const s of profile.stories) {
      lines.push(`  - Story ID: ${s.id}`);
      lines.push(`    Theme: ${oneLine(s.theme)}`);
      lines.push(`    Title: ${oneLine(s.title)}`);
      lines.push(`    Situation: ${oneLine(s.situation)}`);
      lines.push(`    Task: ${oneLine(s.task)}`);
      lines.push(`    Action: ${oneLine(s.action)}`);
      lines.push(`    Result: ${oneLine(s.result)}`);
    }
  }

  return lines.join("\n");
}

function oneLine(value: string | null | undefined): string {
  if (value == null) return "(not provided)";
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return "(not provided)";
  return trimmed.replace(/\s+/g, " ");
}

function buildPromptBlocks(args: AnalyzeArgs) {
  const transcriptText =
    (args.transcript.editedText ?? args.transcript.redactedText) || "";

  // Step 1: clamp the transcript first. The transcript is the
  // single largest contributor in the worst case, so capping it
  // first gives us the most predictable upper bound and leaves
  // headroom for the artifact section.
  const clampedTranscript = clampWithHeadAndTail(
    transcriptText,
    MAX_TRANSCRIPT_BODY_CHARS,
  );

  // Step 2: build the per-artifact (header, body) pairs and clamp
  // the aggregate to MAX_ARTIFACT_BODY_CHARS via round-robin trim.
  //
  // The header carries provenance so the analyzer knows what to
  // trust:
  //   - "user-added"          : the candidate typed/uploaded this
  //   - "AI-inferred,         : Haiku's guess at a question the
  //      candidate-confirmed"   candidate then accepted (effectively
  //                             ground-truth at this point)
  //   - "AI-inferred,         : Haiku's guess that the candidate
  //      candidate did not     never confirmed. Treat as a best-
  //      confirm"              guess of the prompt, not as fact.
  // Without this, the analyzer used to flatten everything into a
  // generic "candidate-supplied artifact", which let the report
  // either over-trust an inferred question (treating it as
  // verbatim) or — when the inference pass returned zero rows —
  // call out "the candidate didn't supply the question list" even
  // though Haiku had been called.
  const rawArtifactPairs = args.artifacts
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((a, i) => ({
      header: buildArtifactHeader(i + 1, a),
      // For `design_image` rows, `content` (when set) is the
      // original candidate-uploaded filename, not narrative text;
      // we lift it into the `[image …]` reference so the analyzer
      // sees one coherent token rather than a bare filename. Other
      // types keep the simple text body.
      body:
        a.artifactType === "design_image"
          ? a.imageUrl
            ? a.content?.trim()
              ? `[image "${a.content.trim()}": ${a.imageUrl}]`
              : `[image: ${a.imageUrl}]`
            : (a.content?.trim() ?? "")
          : (a.content?.trim() || (a.imageUrl ? `[image: ${a.imageUrl}]` : "")),
    }));

  const clampedArtifactPairs = clampArtifactBlocks(
    rawArtifactPairs,
    MAX_ARTIFACT_BODY_CHARS,
  );

  const artifactBlocks = clampedArtifactPairs
    .map((p) => `${p.header}\n${p.body}`)
    .join("\n\n");

  const rubric = rubricFor(args.session.roundType, args.session.level as InterviewLevel);

  const sessionContext = [
    `# Session metadata`,
    ``,
    `- Company: ${args.session.companyName}`,
    `- Role: ${args.session.roleTitle}`,
    `- Level: ${args.session.level}`,
    `- Round type: ${args.session.roundType}`,
    `- Duration: ${args.transcript.durationSeconds}s`,
    `- Word count: ${args.transcript.wordCount}`,
    `- Filler-word count: ${args.transcript.fillerWordCount}`,
    ``,
    `# Transcript (redacted${
      args.transcript.editedText ? "; edited by candidate" : ""
    })`,
    ``,
    clampedTranscript ||
      "[empty — transcription failed; report this in executiveSummary]",
    ``,
    artifactBlocks ? `# Candidate-supplied artifacts\n\n${artifactBlocks}` : "",
    args.profile ? buildProfileSnapshot(args.profile) : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Step 3: hard ceiling on the combined body. Should never trip
  // given the per-section caps, but is the load-bearing safety
  // net if we ever raise an individual cap without re-checking.
  const finalContext =
    sessionContext.length > MAX_PROMPT_BODY_CHARS
      ? clampWithHeadAndTail(sessionContext, MAX_PROMPT_BODY_CHARS)
      : sessionContext;

  return {
    rubric,
    sessionContext: finalContext,
  };
}

/**
 * Single LLM call with retry-on-schema-failure. Returns the
 * validated report or throws `LlmValidationError`.
 *
 * When `coreOnly` is true the call uses the smaller
 * `CORE_MAX_TOKENS_BY_ROUND` budget and appends `CORE_SCOPE_HINT` to
 * the user message so the model skips `questionsCovered` /
 * `per_question_analytics` (those are generated concurrently by
 * `generateAnalytics`). The returned report will have
 * `questionsCovered: []`; the caller is responsible for merging the
 * real analytics from the concurrent call.
 */
export async function generateReport(args: AnalyzeArgs & { coreOnly?: boolean }): Promise<AnalyzeResult> {
  const { rubric, sessionContext } = buildPromptBlocks(args);
  const client = getLlmClient();

  const maxTokens = args.coreOnly
    ? CORE_MAX_TOKENS_BY_ROUND[args.session.roundType]
    : MAX_TOKENS_BY_ROUND[args.session.roundType];
  const model = LLM_MODEL_LARGE;

  const baseUserParts = [
    rubric,
    sessionContext,
    ...(args.differentiationHint ? [args.differentiationHint] : []),
    ...(args.coreOnly ? [CORE_SCOPE_HINT] : []),
  ];

  let lastRaw = "";
  let lastErrorWasJsonParse = false;
  for (let attempt = 0; attempt <= MAX_RETRIES_ON_VALIDATION; attempt++) {
    const retryGuidance = lastErrorWasJsonParse
      ? "Your previous response was NOT valid JSON. The most common cause is " +
        'unescaped double-quote characters inside a string value (e.g. embedding `"foo"` ' +
        'inside an `\"evidence\"` quote). Inside any JSON string value, every literal ' +
        'double-quote MUST be escaped as \\\". Do NOT use smart quotes. Do NOT add ' +
        "trailing commas. Return ONLY a valid JSON object matching the schema in the " +
        "system prompt — no Markdown fencing, no commentary. Previous response:\n\n" +
        lastRaw
      : "Your previous response did not match the required JSON schema. " +
        "Please return ONLY a valid JSON object matching the schema in the " +
        "system prompt — no Markdown fencing, no commentary. Previous response:\n\n" +
        lastRaw;

    const userMessageText =
      attempt === 0
        ? baseUserParts.join("\n\n")
        : [...baseUserParts, retryGuidance].join("\n\n");

    const callStart = Date.now();
    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessageText },
      ],
    });
    const callElapsedMs = Date.now() - callStart;

    console.warn(
      `[generateReport] llm_call_complete elapsed_ms=${callElapsedMs} ` +
        `attempt=${attempt} round=${args.session.roundType} ` +
        `max_tokens=${maxTokens} ` +
        `completion_tokens=${response.usage?.completion_tokens ?? "?"} ` +
        `prompt_tokens=${response.usage?.prompt_tokens ?? "?"} ` +
        `finish_reason=${response.choices[0]?.finish_reason ?? "unknown"}`,
    );

    const text = (response.choices[0]?.message?.content || "").trim();

    lastRaw = text;

    if (response.choices[0]?.finish_reason === "length") {
      throw new LlmValidationError(
        `Report was truncated at the max_tokens cap (${maxTokens} for ` +
          `${args.session.roundType}). The model needs more output budget ` +
          `for this transcript — bump MAX_TOKENS_BY_ROUND.${args.session.roundType}.`,
        text,
      );
    }

    const parsed = tryParseReport(text);
    if (parsed.ok) {
      const flat = flatReportForForbiddenCheck(parsed.report);
      const hits = findForbiddenLanguage(flat);
      if (hits.length > 0 && attempt < MAX_RETRIES_ON_VALIDATION) {
        continue;
      }
      if (hits.length > 0) {
        throw new LlmValidationError(
          `Report contains forbidden pass/fail language: ${hits
            .map((h) => `"${h.excerpt}"`)
            .join(", ")}`,
          text,
        );
      }
      return {
        report: parsed.report,
        modelVersion: model,
        rubricVersion: RUBRIC_VERSION,
      };
    }

    lastErrorWasJsonParse = parsed.error.startsWith("not valid JSON:");

    if (attempt === MAX_RETRIES_ON_VALIDATION) {
      throw new LlmValidationError(
        `Report failed schema validation: ${parsed.error}`,
        text,
      );
    }
  }

  // Unreachable — the loop either returns or throws.
  throw new LlmValidationError("unreachable", lastRaw);
}

/**
 * Analytics-only parallel call: generate `questionsCovered` and
 * `per_question_analytics` for the same session without generating the
 * full narrative report. Intended to run concurrently with
 * `generateReport({ coreOnly: true, ... })` so the two most expensive
 * output sections (narrative + analytics) are produced in parallel.
 *
 * Returns `{ questionsCovered: [], per_question_analytics: undefined }`
 * on any failure rather than throwing — the caller merges a best-effort
 * result and analytics degrading gracefully is far better than blocking
 * the whole analysis on a transient analytics error.
 *
 * No forbidden-language check (pure extraction, no model-framing risk).
 * One internal validation retry on schema failure, same as the core call.
 */
export async function generateAnalytics(
  args: AnalyzeArgs,
): Promise<AnalyticsResult> {
  const { rubric, sessionContext } = buildPromptBlocks(args);
  const client = getLlmClient();
  const maxTokens = ANALYTICS_MAX_TOKENS_BY_ROUND[args.session.roundType];
  const model = LLM_MODEL_LARGE;

  const baseUserParts = [rubric, sessionContext, ANALYTICS_SCOPE_HINT];

  let lastRaw = "";
  let lastErrorWasJsonParse = false;

  for (let attempt = 0; attempt <= MAX_RETRIES_ON_VALIDATION; attempt++) {
    const retryGuidance = lastErrorWasJsonParse
      ? "Your previous response was NOT valid JSON. Escape inner double-quotes " +
        "as \\\". No trailing commas. Return ONLY a valid JSON object with keys " +
        "questionsCovered and per_question_analytics. Previous response:\n\n" + lastRaw
      : "Your previous response did not match the required JSON schema for " +
        "questionsCovered and per_question_analytics. Return ONLY a valid JSON " +
        "object with those two keys. Previous response:\n\n" + lastRaw;

    const userMessageText =
      attempt === 0
        ? baseUserParts.join("\n\n")
        : [...baseUserParts, retryGuidance].join("\n\n");

    const callStart = Date.now();
    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessageText },
      ],
    });
    const callElapsedMs = Date.now() - callStart;

    console.warn(
      `[generateAnalytics] llm_call_complete elapsed_ms=${callElapsedMs} ` +
        `attempt=${attempt} round=${args.session.roundType} ` +
        `max_tokens=${maxTokens} ` +
        `completion_tokens=${response.usage?.completion_tokens ?? "?"} ` +
        `finish_reason=${response.choices[0]?.finish_reason ?? "unknown"}`,
    );

    if (response.choices[0]?.finish_reason === "length") {
      throw new LlmValidationError(
        `Analytics truncated at max_tokens cap (${maxTokens} for ` +
          `${args.session.roundType}).`,
        "",
      );
    }

    const text = (response.choices[0]?.message?.content || "").trim();

    lastRaw = text;

    const stripped = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const parsed = parseJsonWithRepair(stripped);
    if (!parsed.ok) {
      lastErrorWasJsonParse = true;
      if (attempt === MAX_RETRIES_ON_VALIDATION) {
        throw new LlmValidationError(
          `Analytics JSON parse failed: ${parsed.error}`,
          text,
        );
      }
      continue;
    }

    const result = analyticsOutputSchema.safeParse(parsed.value);
    if (!result.success) {
      lastErrorWasJsonParse = false;
      if (attempt === MAX_RETRIES_ON_VALIDATION) {
        throw new LlmValidationError(
          `Analytics schema validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          text,
        );
      }
      continue;
    }

    return {
      questionsCovered: result.data.questionsCovered,
      per_question_analytics: result.data.per_question_analytics,
    };
  }

  // Unreachable.
  throw new LlmValidationError("generateAnalytics unreachable", lastRaw);
}

/**
 * Stories-only parallel call: generate the `storyHighlights` array for
 * the same session without generating the full narrative report or the
 * analytics block. Intended to run concurrently with
 * `generateReport({ coreOnly: true, ... })` and `generateAnalytics` so
 * the three heaviest output sections are produced in parallel.
 *
 * Returns `{ storyHighlights: [] }` on any failure — same graceful-
 * degradation contract as `generateAnalytics`. An empty stories block
 * is valid for the renderer (the section just disappears from the UI),
 * which is far better than blocking the whole analysis on a flaky
 * stories pass.
 *
 * No forbidden-language check (the storyHighlights body length cap
 * and the system-prompt rules already constrain framing).
 * One internal validation retry on schema failure, same as the core call.
 */
export async function generateStoryHighlights(
  args: AnalyzeArgs,
): Promise<StoryHighlightsResult> {
  const { rubric, sessionContext } = buildPromptBlocks(args);
  const client = getLlmClient();
  const maxTokens = STORIES_MAX_TOKENS_BY_ROUND[args.session.roundType];
  const model = LLM_MODEL_LARGE;

  const baseUserParts = [rubric, sessionContext, STORIES_SCOPE_HINT];

  let lastRaw = "";
  let lastErrorWasJsonParse = false;

  for (let attempt = 0; attempt <= MAX_RETRIES_ON_VALIDATION; attempt++) {
    const retryGuidance = lastErrorWasJsonParse
      ? "Your previous response was NOT valid JSON. Escape inner double-quotes " +
        "as \\\". No trailing commas. Return ONLY a valid JSON object with " +
        "the single key storyHighlights. Previous response:\n\n" + lastRaw
      : "Your previous response did not match the required JSON schema for " +
        "storyHighlights. Return ONLY a valid JSON object with that one key. " +
        "Previous response:\n\n" + lastRaw;

    const userMessageText =
      attempt === 0
        ? baseUserParts.join("\n\n")
        : [...baseUserParts, retryGuidance].join("\n\n");

    const callStart = Date.now();
    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessageText },
      ],
    });
    const callElapsedMs = Date.now() - callStart;

    console.warn(
      `[generateStoryHighlights] llm_call_complete elapsed_ms=${callElapsedMs} ` +
        `attempt=${attempt} round=${args.session.roundType} ` +
        `max_tokens=${maxTokens} ` +
        `completion_tokens=${response.usage?.completion_tokens ?? "?"} ` +
        `finish_reason=${response.choices[0]?.finish_reason ?? "unknown"}`,
    );

    if (response.choices[0]?.finish_reason === "length") {
      throw new LlmValidationError(
        `Stories truncated at max_tokens cap (${maxTokens} for ` +
          `${args.session.roundType}).`,
        "",
      );
    }

    const text = (response.choices[0]?.message?.content || "").trim();

    lastRaw = text;

    const stripped = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const parsed = parseJsonWithRepair(stripped);
    if (!parsed.ok) {
      lastErrorWasJsonParse = true;
      if (attempt === MAX_RETRIES_ON_VALIDATION) {
        throw new LlmValidationError(
          `Stories JSON parse failed: ${parsed.error}`,
          text,
        );
      }
      continue;
    }

    const result = storyHighlightsOutputSchema.safeParse(parsed.value);
    if (!result.success) {
      lastErrorWasJsonParse = false;
      if (attempt === MAX_RETRIES_ON_VALIDATION) {
        throw new LlmValidationError(
          `Stories schema validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          text,
        );
      }
      continue;
    }

    return { storyHighlights: result.data.storyHighlights };
  }

  // Unreachable.
  throw new LlmValidationError("generateStoryHighlights unreachable", lastRaw);
}

/**
 * Build the text we hand to `findForbiddenLanguage`. The
 * forbidden-pattern regex set in `forbidden.ts` exists to catch
 * the MODEL'S OWN FRAMING as pass/fail; it should not trip on
 * candidate-echoed verbatim speech. Schema fields that hold
 * verbatim transcript snippets (or candidate-supplied artifact
 * text) are zeroed out before stringification:
 *
 *   - `strengths[].evidence[].quote` / `improvements[].evidence[].quote`
 *     — direct candidate quotes the model pulled to anchor a point.
 *   - `questionsCovered[].evidenceQuote`
 *     — verbatim candidate answer snippet anchoring a question
 *       inference.
 *   - `communicationSignals.fillerWords.topOffenders[]`
 *     — the candidate's own filler words; can contain words like
 *       "pass" or "fail" in a way that has nothing to do with
 *       hire/no-hire framing.
 *
 * Pure: returns a serialized string; does not mutate `report`.
 * Exported for testing.
 */
export function flatReportForForbiddenCheck(report: Report): string {
  const clone = structuredClone(report);
  for (const s of clone.strengths) s.evidence = [];
  for (const i of clone.improvements) i.evidence = [];
  for (const q of clone.questionsCovered) delete q.evidenceQuote;
  clone.communicationSignals.fillerWords.topOffenders = [];
  return JSON.stringify(clone);
}

interface ParseOk {
  ok: true;
  report: Report;
}
interface ParseErr {
  ok: false;
  error: string;
}

function tryParseReport(raw: string): ParseOk | ParseErr {
  // The model often wraps JSON in ```json ... ``` despite the
  // instruction not to. Strip the fence as a courtesy.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const parsed = parseJsonWithRepair(stripped);
  if (!parsed.ok) {
    return parsed;
  }

  // Pre-sanitize `per_question_analytics` before Zod runs so a
  // hallucinated artifact_id doesn't sink the whole report. The field is documented as
  // optional precisely so it can degrade gracefully — the
  // renderer treats `undefined` as "analytics not available" and
  // shows the rest of the report. Without this salvage, a single
  // bad UUID on entry 0 of 12 fails the whole analysis and
  // refunds the user's credits, even though entries 1-11 + the
  // entire prose report were perfectly fine.
  const sanitized = sanitizeReportInput(parsed.value);

  const result = reportSchema.safeParse(sanitized);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }

  return { ok: true, report: result.data };
}

export interface JsonParseOk {
  ok: true;
  value: unknown;
  /**
   * True iff the raw text failed `JSON.parse` and we recovered
   * via `jsonrepair`. The caller uses this for telemetry only —
   * downstream code treats both branches the same.
   */
  repaired: boolean;
}
export interface JsonParseErr {
  ok: false;
  error: string;
}

/**
 * Parse the LLM's JSON output, falling back to `jsonrepair` when
 * the raw response isn't valid JSON. Recovers from a handful of
 * model output patterns that crashed `JSON.parse` in production:
 *
 *   1. Unescaped double-quotes inside a string value, usually when
 *      the model wrapped a candidate quote in quotation marks:
 *        `"quote":"\"you know\" — repeated throughout"`
 *      The model emits `"quote":"you know" — repeated throughout"`
 *      which breaks the parser at the first inner `"`.
 *
 *   2. Trailing commas inside arrays / objects (the model
 *      occasionally adds one after the last entry).
 *
 *   3. Smart quotes (`“ ” ‘ ’`) used instead of straight quotes —
 *      rare with Sonnet but cheap to handle.
 *
 *   4. Truncation patterns that aren't `stop_reason: max_tokens`
 *      (e.g. the model wrote `... "` and stopped) — `jsonrepair`
 *      closes the open structures so the report is salvageable.
 *
 * Pure: returns a new object; never mutates the input. Exported
 * via `tryParseReport` for the production path; the tests exercise
 * the repair branch directly through the malformed-JSON cases in
 * `client-parse.test.ts`.
 *
 * On the rare case that BOTH `JSON.parse` and `jsonrepair` fail,
 * we surface the ORIGINAL parse error in the returned message
 * (not the repair error) so the retry prompt blames the model's
 * actual mistake instead of a downstream repair artifact.
 */
export function parseJsonWithRepair(
  stripped: string,
): JsonParseOk | JsonParseErr {
  try {
    return { ok: true, value: JSON.parse(stripped), repaired: false };
  } catch (originalErr) {
    let repairedText: string;
    try {
      repairedText = jsonrepair(stripped);
    } catch {
      return {
        ok: false,
        error: `not valid JSON: ${(originalErr as Error).message}`,
      };
    }

    try {
      return { ok: true, value: JSON.parse(repairedText), repaired: true };
    } catch {
      return {
        ok: false,
        error: `not valid JSON: ${(originalErr as Error).message}`,
      };
    }
  }
}

/**
 * Lossy pre-validation cleanup of the `per_question_analytics`
 * array. Mirrors the documented intent on the schema field
 * (`schema.ts` `per_question_analytics` block) and the prompt
 * version banner: the field is OPTIONAL, and on per-entry
 * validation failure we strip the bad entries (or the whole
 * field when nothing survives) rather than failing the whole
 * analysis.
 *
 * Hard-drop: any entry that fails
 *   `perQuestionAnalyticsSchema.safeParse` gets dropped from the
 *   array. Most commonly: an `artifact_id` that isn't a valid UUID
 *   (the model fabricated one when no question artifact existed for
 *   that segment). Guardrail 3 in `runAnalyticsGuardrails` would
 *   have caught a wrong-but-shaped UUID here too, so dropping at
 *   the schema layer is consistent with the post-validation guardrail
 *   posture.
 *
 * If the cleaned array is empty, the field is stripped entirely
 * (vs. emitting `[]`) so the renderer's "analytics not available"
 * branch fires — an empty array would show a section with zero
 * rows, which is worse UX than hiding it.
 *
 * Truncates to 30 entries since that's the schema cap; an over-cap
 * array that would otherwise fail `.max(30)` becomes valid.
 *
 * Pure: returns a NEW object; never mutates the input.
 *
 * Exported so tests can pin the salvage behavior without spinning
 * up the full LLM call (the consumer in `tryParseReport` is the
 * only production caller).
 */
export function sanitizeReportInput(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  const obj = { ...(parsed as Record<string, unknown>) };

  // 1. Backfill load-bearing required fields that the LLM may have
  //    returned empty or missing. The user's complaint that made
  //    these necessary: a 2-second misclick recording made the
  //    model honestly emit `strengths: []` / `improvements: []` —
  //    both schema-illegal, both load-bearing for the report page.
  //    Failing here would refund-and-fail the session, leaving the
  //    user staring at "Analysis didn't complete" with no
  //    actionable next step.
  //
  //    Strategy: top off the empty/missing required fields with a
  //    single "we couldn't extract this from the transcript" stub.
  //    The thin-transcript short-circuit in the worker prefers to
  //    catch this case BEFORE the LLM is called, but defense-in-
  //    depth here covers the pathological case where the LLM gets
  //    confused and returns a sparse response on a longer
  //    transcript.
  if (!isNonEmptyString(obj.executiveSummary)) {
    obj.executiveSummary =
      "We couldn't extract a full assessment from this recording. The rest of the report explains what we were able to capture; you can re-analyze if you'd like a fuller take.";
  }

  if (!isNonEmptyArray(obj.strengths)) {
    obj.strengths = [
      {
        heading: "Recording captured",
        detail:
          "We have your transcript on file. If this report feels sparse, re-analyze the round \u2014 the rest of the pipeline can run again without re-recording.",
        evidence: [],
      },
    ];
  }

  if (!isNonEmptyArray(obj.improvements)) {
    obj.improvements = [
      {
        heading: "Re-analyze for a fuller report",
        detail:
          "We couldn't anchor a full set of improvements in this recording's transcript. Re-analyzing or re-recording usually fixes that.",
        action:
          "Open the edit screen and click \u201cRe-analyze\u201d to try again.",
        evidence: [],
        rebuildEligible: false,
      },
    ];
  }

  // 2. Existing per_question_analytics salvage — drop unrecoverable
  //    entries before Zod sees them.
  if ("per_question_analytics" in obj) {
    const pqa = obj.per_question_analytics;
    if (!Array.isArray(pqa)) {
      // Wrong shape entirely (model returned an object, a string,
      // null). Strip rather than try to repair — the rest of the
      // report is more valuable than retrying validation forever.
      delete obj.per_question_analytics;
    } else {
      const cleaned: unknown[] = [];
      for (const raw of pqa) {
        if (typeof raw !== "object" || raw === null) continue;
        const entry: Record<string, unknown> = {
          ...(raw as Record<string, unknown>),
        };
        if (!perQuestionAnalyticsSchema.safeParse(entry).success) continue;
        cleaned.push(entry);
        if (cleaned.length >= 30) break;
      }
      if (cleaned.length === 0) {
        delete obj.per_question_analytics;
      } else {
        obj.per_question_analytics = cleaned;
      }
    }
  }

  return obj;
}

/**
 * True iff `v` is a non-empty string after trimming. Used by
 * `sanitizeReportInput` to detect "empty string" responses that
 * Zod would reject under `z.string().min(1)`.
 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * True iff `v` is an array with at least one entry. Used by
 * `sanitizeReportInput` to detect the empty-array case that Zod
 * rejects under `z.array(...).min(1)`.
 */
function isNonEmptyArray(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.length > 0;
}

/**
 * Build a valid `Report` for the round-specific block keyed on the
 * session's round type. Each prose field is a one-sentence
 * "couldn't assess" stub. Shared between `buildPlaceholderReport`
 * and `buildFallbackReport` so both surfaces stay in lockstep with
 * `roundSpecificSchema`'s discriminated union.
 */
function buildRoundSpecificStub(
  round: AnalyzeArgs["session"]["roundType"],
  detail: string,
): Report["roundSpecific"] {
  if (round === "coding") {
    return {
      kind: "coding",
      problemFraming: detail,
      solutionExploration: detail,
      implementationHygiene: detail,
      verification: detail,
      recoveryFromFeedback: detail,
    };
  }
  if (round === "system_design") {
    return {
      kind: "system_design",
      requirementsGathering: detail,
      highLevelDesign: detail,
      deepDives: detail,
      tradeOffsAndFailureModes: detail,
      scalingStory: detail,
    };
  }
  if (round === "behavioral") {
    return {
      kind: "behavioral",
      starCompleteness: detail,
      specificity: detail,
      selfAwareness: detail,
      leadershipSignals: detail,
    };
  }
  return {
    kind: "other",
    understanding: detail,
    structure: detail,
    reasoning: detail,
    engagement: detail,
  };
}

/**
 * Bulletproof fallback report. Used by the analyze worker when:
 *
 *   - The transcript is too thin to support a real analysis
 *     (`isThinTranscript` is true). We short-circuit before the
 *     LLM call.
 *   - The LLM call succeeded but the response failed schema
 *     validation even after the retry. We salvage rather than
 *     refund-and-fail so the user always sees a report.
 *   - The LLM is not configured / unreachable in a deployment
 *     where placeholder reports aren't appropriate.
 *
 * The returned report ALWAYS satisfies `reportSchema` (it's built
 * from the same constants the schema enforces — at least one
 * strength, at least one improvement, every required prose field
 * populated). `modelVersion` carries the sentinel prefix
 * `fallback:` so the worker (and ops queries) can distinguish a
 * fallback persistence from a real LLM persistence; the worker
 * uses this to issue a credit refund.
 *
 * Copy is written for the CANDIDATE — blunt, second-person,
 * non-clinical. Two reasons drive two distinct user-facing
 * narratives because the recovery path is different:
 *
 *   - `thin_transcript` → "re-record the round, your credit is back"
 *   - everything else → "we ran into trouble, try re-analyzing"
 */
export function buildFallbackReport(
  args: AnalyzeArgs,
  reason: FallbackReason,
): AnalyzeResult {
  const round = args.session.roundType;

  // Copy is tuned per reason. We deliberately do NOT include
  // engineer-y phrasing ("validation failed", "schema mismatch") in
  // the user-facing strings — the candidate only cares about what
  // to do next. The reason still ends up in `modelVersion` for ops.
  const isThin = reason === "thin_transcript";

  // When the candidate has supplied edited text, the fallback copy
  // must describe the EDITED material — not the original audio's
  // duration / word count, which are stale by the time the user
  // is re-analyzing from the edit screen. Without this branch a
  // 53k-character edited paste with only a handful of words could
  // surface as "your recording was 3s long" even though there's
  // no recording in play anymore.
  const editedWordCount =
    args.transcript.editedText != null
      ? countWordsInText(args.transcript.editedText)
      : null;
  const effectiveWordCount = editedWordCount ?? args.transcript.wordCount;
  const userEditedTranscript = editedWordCount !== null;

  const headline = isThin
    ? userEditedTranscript
      ? "Your transcript is too short to analyze."
      : "Your recording was too short to analyze."
    : "We couldn't finish your analysis this time.";

  const subhead = isThin
    ? userEditedTranscript
      ? `The edited transcript contains about ${effectiveWordCount} word${effectiveWordCount === 1 ? "" : "s"}, which isn't enough material for real evidence-anchored feedback. Your credit has been refunded — add more detail to the transcript and re-analyze, or record a new round to get a full report.`
      : `The recording was ${args.transcript.durationSeconds}s long and contained about ${effectiveWordCount} word${effectiveWordCount === 1 ? "" : "s"}, which isn't enough material for real evidence-anchored feedback. Your credit has been refunded — re-record the round to get a full report.`
    : "Something on our side prevented us from generating the full report. Your credit has been refunded. Use the \u201cRetry\u201d button above to re-analyze the same transcript — most retries succeed on the second attempt.";

  const stubDetail = isThin
    ? userEditedTranscript
      ? "Couldn't assess from this transcript \u2014 it was too short to capture interview content."
      : "Couldn't assess from this recording \u2014 it was too short to capture interview content."
    : "Couldn't assess on this attempt \u2014 the full analysis didn't complete. Try re-analyzing.";

  const strengthHeading = isThin
    ? userEditedTranscript
      ? "Your edits are saved"
      : "You finished the recording flow"
    : "Your recording is safe with us";
  const strengthDetail = isThin
    ? userEditedTranscript
      ? "We kept every character you typed. Add a few more lines and re-analyze \u2014 nothing else needs to happen first."
      : "The pipeline made it through transcription \u2014 the next recording will analyze end to end."
    : "We have the transcript and artifacts on file. Re-analyzing won't ask you to re-record.";

  const improvementHeading = isThin
    ? userEditedTranscript
      ? "Flesh out the transcript"
      : "Re-record the round"
    : "Try re-analyzing the round";
  const improvementDetail = isThin
    ? userEditedTranscript
      ? "A useful coaching report needs at least a couple minutes of actual interview content \u2014 paste in or type out the rest of the conversation so the analyzer has something to ground feedback in."
      : "A useful coaching report needs at least a couple minutes of actual interview content \u2014 the more representative of the full call, the better the feedback."
    : "Most transient failures resolve on the second attempt. Use the \u201cRetry\u201d button at the top of this report.";
  const improvementAction = isThin
    ? userEditedTranscript
      ? "Add the rest of the call text in the edit screen, then click \u201cRe-analyze\u201d."
      : "Start a new session and record the full round, then submit for analysis."
    : "Click \u201cRetry\u201d \u2014 we\u2019ll re-run analysis on the same transcript.";

  return {
    report: {
      executiveSummary: `${headline} ${subhead}`,
      strengths: [
        {
          heading: strengthHeading,
          detail: strengthDetail,
          evidence: [],
        },
      ],
      improvements: [
        {
          heading: improvementHeading,
          detail: improvementDetail,
          action: improvementAction,
          evidence: [],
          rebuildEligible: false,
        },
      ],
      communicationSignals: {
        pace: { summary: stubDetail },
        fillerWords: { summary: stubDetail, topOffenders: [] },
        structure: { summary: stubDetail },
        presence: { summary: stubDetail },
      },
      roundSpecific: buildRoundSpecificStub(round, stubDetail),
      aiRead: {
        paragraph: `${headline} ${subhead}`,
      },
      questionsCovered: [],
      storyHighlights: [],
    },
    modelVersion: `${FALLBACK_MODEL_VERSION_PREFIX}${reason}`,
    rubricVersion: RUBRIC_VERSION,
  };
}

/**
 * Dev-mode placeholder report. Used by the analyze worker when
 * `features.llmAnalysis` is false so contributors can step through
 * the full review/report pipeline without needing a running LLM
 * backend. The shape matches `reportSchema`; the body is clearly
 * marked as a placeholder.
 */
export function buildPlaceholderReport(args: AnalyzeArgs): AnalyzeResult {
  const round = args.session.roundType;
  const roundSpecific: Report["roundSpecific"] = (() => {
    if (round === "coding") {
      return {
        kind: "coding",
        problemFraming: "Placeholder — real analysis is disabled in this environment.",
        solutionExploration: "Placeholder.",
        implementationHygiene: "Placeholder.",
        verification: "Placeholder.",
        recoveryFromFeedback: "Placeholder.",
      };
    }
    if (round === "system_design") {
      return {
        kind: "system_design",
        requirementsGathering: "Placeholder — real analysis is disabled.",
        highLevelDesign: "Placeholder.",
        deepDives: "Placeholder.",
        tradeOffsAndFailureModes: "Placeholder.",
        scalingStory: "Placeholder.",
      };
    }
    if (round === "behavioral") {
      return {
        kind: "behavioral",
        starCompleteness: "Placeholder — real analysis is disabled.",
        specificity: "Placeholder.",
        selfAwareness: "Placeholder.",
        leadershipSignals: "Placeholder.",
        storyHighlights: [],
      };
    }
    return {
      kind: "other",
      understanding: "Placeholder — real analysis is disabled.",
      structure: "Placeholder.",
      reasoning: "Placeholder.",
      engagement: "Placeholder.",
    };
  })();

  return {
    report: {
      executiveSummary:
        "This is a placeholder report — LLM is not configured (Ollama not running or model not pulled). Ensure Ollama is running at OLLAMA_BASE_URL and the model is pulled to enable real analysis.",
      strengths: [
        {
          heading: "You finished the recording",
          detail:
            "The pipeline made it end-to-end through transcription and report generation.",
          evidence: [],
        },
      ],
      improvements: [
        {
          heading: "Configure LLM backend",
          detail:
            "Real coaching feedback requires a running Ollama instance with the model pulled.",
          action: "Start Ollama and pull the configured model, then re-run analysis.",
          evidence: [],
          // Placeholder is operational guidance, not a story-shape
          // gap — the inline rebuild affordance would be nonsense
          // here. The flag is the load-bearing signal the report
          // view reads to decide whether to render the button.
          rebuildEligible: false,
        },
      ],
      communicationSignals: {
        pace: { summary: "n/a — placeholder" },
        fillerWords: { summary: "n/a — placeholder", topOffenders: [] },
        structure: { summary: "n/a — placeholder" },
        presence: { summary: "n/a — placeholder" },
      },
      roundSpecific,
      aiRead: {
        paragraph:
          "Real analysis is disabled in this environment. This is a placeholder report so the rest of the pipeline can be exercised end-to-end.",
        readinessScore: 50,
      },
      // Placeholder mirrors the production shape: a single
      // clearly-labeled stub so the report-page renderer exercises
      // the questions section without an LLM round-trip.
      questionsCovered: [
        {
          question: "Placeholder — LLM is not configured in this environment.",
          confidence: "low",
          source: "transcript_inferred",
        },
      ],
      storyHighlights: [],
    },
    modelVersion: "placeholder",
    rubricVersion: RUBRIC_VERSION,
  };
}
