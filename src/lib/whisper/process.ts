/**
 * Deterministic, side-effect-free post-processors for a faster-whisper
 * transcription response. Lives in its own module so the pipeline
 * stays a thin orchestrator and these helpers can be unit-tested without
 * touching the transcription engine or the database.
 *
 * What we promise to consumers:
 *   - The same input ALWAYS produces the same `(rawText, redactedText,
 *     redactionCount, candidateSpeaker, wordCount, fillerWordCount)`
 *     tuple, regardless of whether transcription succeeds upstream.
 *   - We never throw on missing/malformed sub-fields — the response is
 *     loosely typed at the leaves (utterances, words, and speaker numbers
 *     are all `?`). A malformed response should gracefully degrade to
 *     "no candidate identified, no redactions", not crash the worker.
 *
 * Spec-mandated behavior:
 *   - The "candidate" is the speaker with the most cumulative speech
 *     time (sum of utterance durations). Word count is a tie-breaker
 *     so a single long pause from the second speaker can't flip
 *     identification.
 *   - Every utterance NOT spoken by the candidate is replaced with
 *     a fixed redaction marker — we never persist the interviewer's
 *     words in any column the candidate (or our LLMs) can read.
 *   - Filler words: { um, uh, like, you know, basically, literally,
 *     actually, "so" as a sentence opener }. The "so as opener" rule
 *     is the only context-sensitive one — it prevents counting "so"
 *     as filler in the middle of a sentence.
 */

/** Minimal subset of the transcription response shape we depend on. */
export interface TranscriptionUtterance {
  start?: number;
  end?: number;
  transcript?: string;
  speaker?: number;
  words?: TranscriptionWord[];
}

export interface TranscriptionWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  speaker?: number;
}

export interface TranscriptionResponse {
  metadata?: {
    duration?: number;
  };
  results?: {
    utterances?: TranscriptionUtterance[];
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
      }>;
    }>;
  };
}

/**
 * Sentinel string we substitute for any utterance that did NOT come
 * from the candidate. Includes a colon so a future processor can
 * reliably detect "this paragraph is a redaction marker, skip it".
 */
export const REDACTION_MARKER = "[redacted: possible second speaker]";

export interface ProcessedTranscript {
  /**
   * Server-observed audio duration in seconds, derived from the
   * transcription response. This is the SOURCE OF TRUTH for billing.
   *
   * Resolution order:
   *   1. `response.metadata.duration` (the transcriber's measured length).
   *   2. `max(utterances[].end)` as a fallback when metadata is missing.
   *   3. `null` when both are missing — caller decides how to react.
   */
  audioDurationSeconds: number | null;
  /**
   * Verbatim concatenation of every utterance, in order. Includes
   * the interviewer's words. NEVER displayed in the UI; lives in
   * the `raw_text` column for support / debugging only.
   */
  rawText: string;
  /**
   * Transcript with non-candidate utterances replaced by
   * `REDACTION_MARKER`. This is what the candidate sees by default
   * in the review UI.
   */
  redactedText: string;
  /**
   * Number of utterances that were redacted. Drives the "we
   * detected and redacted N segments…" banner on the review page.
   */
  redactionCount: number;
  /**
   * Identified candidate speaker number, or `null` when we couldn't
   * find any (single-speaker audio with no diarization, empty
   * response, etc.). When `null`, NO redactions happen — we treat
   * the whole transcript as the candidate's speech, which is the
   * correct behavior for a recording with only one voice.
   */
  candidateSpeaker: number | null;
  /**
   * Total word count of the candidate's speech only. Used by the
   * downstream feedback report.
   */
  candidateWordCount: number;
  /**
   * Filler-word count from the candidate's speech only.
   */
  candidateFillerWordCount: number;
}

const FILLER_TOKENS: readonly string[] = [
  "um",
  "uh",
  "like",
  "basically",
  "literally",
  "actually",
];

const FILLER_BIGRAMS: readonly [string, string][] = [["you", "know"]];

/** Strip surrounding punctuation from a token before comparison. */
function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}']+/u, "")
    .replace(/[^\p{L}\p{N}']+$/u, "");
}

/**
 * Count filler words in a stream of already-tokenized words. The
 * `previousToken` argument is what makes the "so as sentence opener"
 * rule possible: we only count "so" when it's the first non-empty
 * word OR follows a sentence-ending punctuation token.
 */
export function countFillerWords(text: string): number {
  if (!text) return 0;

  let count = 0;
  let prevToken: string | null = null;
  let sentenceJustEnded = true;

  const tokens = text.split(/\s+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const original = tokens[i]!;
    const word = normalizeWord(original);

    if (!word) {
      if (/[.!?]$/.test(original)) sentenceJustEnded = true;
      continue;
    }

    if (FILLER_TOKENS.includes(word)) {
      count++;
    }

    if (word === "so" && sentenceJustEnded) {
      count++;
    }

    if (prevToken) {
      for (const [a, b] of FILLER_BIGRAMS) {
        if (prevToken === a && word === b) {
          count++;
          break;
        }
      }
    }

    prevToken = word;
    sentenceJustEnded = /[.!?][)"'\]]?$/.test(original);
  }

  return count;
}

/**
 * Word count for a single string. Matches the same tokenization rule
 * as `countFillerWords` so the two metrics stay apples-to-apples.
 */
export function countWords(text: string): number {
  if (!text) return 0;
  return text
    .split(/\s+/)
    .filter((t) => normalizeWord(t).length > 0).length;
}

/**
 * Identify the candidate speaker from the utterance list.
 *
 * Strategy:
 *   1. Aggregate cumulative speaking time per speaker (end - start).
 *   2. Tie-break by total word count.
 *   3. If there are no utterances OR no speaker numbers at all,
 *      return null and let the caller treat everything as candidate.
 */
function identifyCandidate(
  utterances: readonly TranscriptionUtterance[],
): number | null {
  if (utterances.length === 0) return null;

  const speakerToDuration = new Map<number, number>();
  const speakerToWordCount = new Map<number, number>();

  let anyDiarized = false;
  for (const u of utterances) {
    const speaker = u.speaker;
    if (typeof speaker !== "number") continue;
    anyDiarized = true;

    const dur = Math.max(0, (u.end ?? 0) - (u.start ?? 0));
    speakerToDuration.set(
      speaker,
      (speakerToDuration.get(speaker) ?? 0) + dur,
    );

    const wordCount = u.words?.length ?? 0;
    speakerToWordCount.set(
      speaker,
      (speakerToWordCount.get(speaker) ?? 0) + wordCount,
    );
  }

  if (!anyDiarized) return null;

  let bestSpeaker: number | null = null;
  let bestDur = -1;
  let bestWords = -1;
  for (const [speaker, dur] of speakerToDuration) {
    const words = speakerToWordCount.get(speaker) ?? 0;
    if (
      dur > bestDur ||
      (dur === bestDur && words > bestWords) ||
      (dur === bestDur &&
        words === bestWords &&
        (bestSpeaker === null || speaker < bestSpeaker))
    ) {
      bestSpeaker = speaker;
      bestDur = dur;
      bestWords = words;
    }
  }
  return bestSpeaker;
}

/**
 * Main entry point. Accepts the loosely-typed transcription response and
 * returns the fully-derived metrics + texts the worker writes to
 * the transcripts row.
 */
export function processDiarization(
  response: TranscriptionResponse,
): ProcessedTranscript {
  const utterances = response.results?.utterances ?? [];

  const channelTranscript =
    response.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ??
    "";

  const audioDurationSeconds = extractAudioDuration(response);

  if (utterances.length === 0) {
    const text = channelTranscript;
    return {
      audioDurationSeconds,
      rawText: text,
      redactedText: text,
      redactionCount: 0,
      candidateSpeaker: null,
      candidateWordCount: countWords(text),
      candidateFillerWordCount: countFillerWords(text),
    };
  }

  const candidateSpeaker = identifyCandidate(utterances);

  let rawText = "";
  let redactedText = "";
  let redactionCount = 0;
  let candidateWordCount = 0;
  let candidateFillerWordCount = 0;

  for (const u of utterances) {
    const transcript = (u.transcript ?? "").trim();
    if (!transcript) continue;

    if (rawText) rawText += "\n";
    rawText += transcript;

    const isCandidate =
      candidateSpeaker === null || u.speaker === candidateSpeaker;

    if (isCandidate) {
      if (redactedText) redactedText += "\n";
      redactedText += transcript;
      candidateWordCount += countWords(transcript);
      candidateFillerWordCount += countFillerWords(transcript);
    } else {
      if (redactedText) redactedText += "\n";
      redactedText += REDACTION_MARKER;
      redactionCount++;
    }
  }

  return {
    audioDurationSeconds,
    rawText,
    redactedText,
    redactionCount,
    candidateSpeaker,
    candidateWordCount,
    candidateFillerWordCount,
  };
}

/**
 * Pull the authoritative audio duration out of a transcription response.
 *
 * Order of preference:
 *   1. `metadata.duration` — the transcriber's measurement of the file.
 *   2. `max(utterances[].end)` — a safe lower bound when metadata is
 *      missing.
 *   3. `null` when neither signal is available.
 */
export function extractAudioDuration(
  response: TranscriptionResponse,
): number | null {
  const metadataDuration = response.metadata?.duration;
  if (
    typeof metadataDuration === "number" &&
    Number.isFinite(metadataDuration) &&
    metadataDuration > 0
  ) {
    return Math.ceil(metadataDuration);
  }

  const utterances = response.results?.utterances ?? [];
  let maxEnd = 0;
  for (const u of utterances) {
    if (
      typeof u.end === "number" &&
      Number.isFinite(u.end) &&
      u.end > maxEnd
    ) {
      maxEnd = u.end;
    }
  }
  if (maxEnd > 0) return Math.ceil(maxEnd);
  return null;
}
