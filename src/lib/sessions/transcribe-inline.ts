import "server-only";

import { WhisperNotConfiguredError } from "@/lib/whisper";
import {
  processDiarization,
  type ProcessedTranscript,
} from "@/lib/whisper/process";
import { transcribeAudioObject } from "@/lib/whisper/transcribe";
import { features } from "@/lib/env";
import { StorageNotConfiguredError } from "@/lib/storage";

import {
  loadAudioForTranscription,
  markScheduledDeletion,
  persistTranscriptAndAdvance,
} from "./transcribe";

/**
 * In-process transcription pipeline. Runs the full transcription
 * flow inline: load audio → transcribe → diarize → persist.
 *
 * Lives in its own file so importing it dynamically from the route
 * keeps transcription deps out of the main request bundle until
 * actually needed.
 */
export async function runTranscribeInline(args: {
  sessionId: string;
  audioFileId: string;
  s3Key: string;
  /**
   * Client-reported duration from the upload finalize step. Only
   * used as a fallback when the transcriber doesn't tell us the real
   * audio length.
   */
  durationSeconds: number;
  userId: string;
}): Promise<{ transcriptId: string; transcriptionError: string | null }> {
  // 1. Mark transcription_started_at + load the row.
  const audioFile = await loadAudioForTranscription(args.audioFileId);

  let processed: ProcessedTranscript | null = null;
  let transcriptionError: string | null = null;

  try {
    if (!features.transcription) {
      throw new WhisperNotConfiguredError();
    }

    // 2. Transcribe the audio from local storage.
    const response = await transcribeAudioObject({ s3Key: args.s3Key });

    // 3. Process diarization + filler/word counts.
    processed = processDiarization(response);
  } catch (err) {
    // Map well-known errors to friendly, actionable banner copy.
    // Unmapped errors get a generic user-facing message — raw
    // `${err.name}: ${err.message}` would leak SDK internals to the
    // review banner. Operators get the full detail via console.error.
    console.error("[runTranscribeInline] transcription step failed:", err);
    if (err instanceof WhisperNotConfiguredError) {
      transcriptionError =
        "Auto-transcription is not configured in this environment. " +
        "Ensure faster-whisper is installed and WHISPER_MODEL_SIZE is set " +
        "in .env.local, then restart the dev server. You can still type " +
        "or paste your transcript below and continue.";
    } else if (err instanceof StorageNotConfiguredError) {
      transcriptionError =
        "Audio storage is not configured in this environment. " +
        "Contact the operator.";
    } else if (err instanceof Error && err.name === "AbortError") {
      transcriptionError =
        "Transcription request was aborted before it could finish. " +
        "Please start a new session and try again.";
    } else {
      transcriptionError =
        "We couldn't auto-transcribe your recording. You can still type or " +
        "paste your transcript below and continue. If this keeps happening, " +
        "please contact support.";
    }
  }

  // 4. Persist the transcript + advance the session, in one
  //    transaction. Note: even on the failure path we still write
  //    the row so the candidate sees a real review screen and can
  //    type/paste a transcript.
  const result = await persistTranscriptAndAdvance({
    sessionId: args.sessionId,
    audioFileId: audioFile.id,
    durationSeconds: args.durationSeconds,
    processed,
    transcriptionError,
    userId: args.userId,
  });

  // 5. Mark scheduled deletion. The privacy-SLA cron sweeper walks
  //    any row with `scheduled_deletion_at <= now() AND deleted_at
  //    IS NULL` and deletes it. Best-effort — a failure here doesn't
  //    block the transcript from being written.
  try {
    await markScheduledDeletion(audioFile.id, 60);
  } catch (err) {
    console.error(
      "[runTranscribeInline] markScheduledDeletion failed:",
      err,
    );
  }

  return {
    transcriptId: result.transcriptId,
    transcriptionError,
  };
}
