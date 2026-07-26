import "server-only";

export class WhisperNotConfiguredError extends Error {
  readonly code = "whisper_not_configured";
  constructor() {
    super(
      "Whisper transcription is not available. Ensure faster-whisper is installed and WHISPER_MODEL_SIZE is set.",
    );
    this.name = "WhisperNotConfiguredError";
  }
}

export interface WhisperConfig {
  modelSize: string;
  device: string;
  language: string;
  computeType: string;
}

/**
 * Returns the resolved whisper configuration from environment variables.
 * Throws if `WHISPER_MODEL_SIZE` is not set (the signal that whisper is
 * intentionally configured in this environment).
 */
export function getWhisperConfig(): WhisperConfig {
  if (!process.env.WHISPER_MODEL_SIZE) throw new WhisperNotConfiguredError();
  return {
    modelSize: process.env.WHISPER_MODEL_SIZE,
    device: process.env.WHISPER_DEVICE || "auto",
    language: process.env.WHISPER_LANGUAGE || "en",
    computeType: process.env.WHISPER_COMPUTE_TYPE || "auto",
  };
}
