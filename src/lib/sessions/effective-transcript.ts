import { countWords } from "@/lib/whisper/process";

/**
 * Resolve the "current" word count for a transcript, preferring the
 * candidate's edited text over the audio-derived count when present.
 *
 * Background: `transcripts.word_count` is populated once, when
 * transcription first lands the row. The PATCH endpoint that accepts
 * post-transcribe edits (`/api/sessions/[id]/transcript`) only
 * updates `edited_text` — `word_count` stays pinned to the
 * original audio so a forensic review can still see the
 * unmodified diarization counts. That means any UI surface
 * grounding `wpm` (or "N words") on `word_count` will read stale
 * the moment the candidate edits the transcript.
 *
 * The contract here mirrors the precedent already used in
 * `src/lib/llm/client.ts` (`effectiveWordCount` near the fallback-
 * report builder): when `editedText` is non-null we treat it as
 * the source of truth — including the explicit "user cleared the
 * transcript" case where the count legitimately drops to zero —
 * and we use `countWords` from `whisper/process` so the helper
 * matches the tokenization that produced the original audio-
 * derived count (whitespace-split, punctuation-only tokens
 * filtered).
 *
 * Pure / boundary-only: no DB, no env access. Lives in
 * `lib/sessions/` because the call sites are session-page
 * server components.
 */
export interface EffectiveTranscriptInput {
  /** Audio-derived word count persisted on the transcripts row. */
  wordCount: number;
  /** Candidate-supplied edited text. `null` when never edited. */
  editedText?: string | null;
}

export function effectiveWordCount(input: EffectiveTranscriptInput): number {
  if (input.editedText != null) {
    return countWords(input.editedText);
  }
  return input.wordCount;
}
