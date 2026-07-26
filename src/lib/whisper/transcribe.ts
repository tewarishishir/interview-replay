import "server-only";

import { execFile } from "node:child_process";
import path from "node:path";

import { getWhisperConfig, WhisperNotConfiguredError } from "./index";
import type { TranscriptionResponse } from "./process";

const TRANSCRIBE_SCRIPT = path.resolve(
  process.cwd(),
  "scripts",
  "transcribe.py",
);

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class TranscriptionTimeoutError extends Error {
  readonly code = "transcription_timeout";
  constructor(filePath: string) {
    super(
      `Transcription timed out after ${TIMEOUT_MS / 1000}s for: ${filePath}`,
    );
    this.name = "TranscriptionTimeoutError";
  }
}

export class TranscriptionProcessError extends Error {
  readonly code = "transcription_process_error";
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(exitCode: number | null, stderr: string) {
    super(
      `Transcription subprocess failed (exit ${exitCode}): ${stderr.slice(0, 500)}`,
    );
    this.name = "TranscriptionProcessError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class TranscriptionParseError extends Error {
  readonly code = "transcription_parse_error";
  constructor(cause: unknown) {
    super(
      `Failed to parse transcription output: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "TranscriptionParseError";
  }
}

/**
 * Transcribe a local audio file using faster-whisper via a Python
 * subprocess. Returns a response shape compatible with the processing
 * pipeline in `./process.ts`.
 *
 * @param filePath - Absolute path to the audio file on disk.
 */
export async function transcribeLocalFile(
  filePath: string,
): Promise<TranscriptionResponse> {
  const config = getWhisperConfig();

  const args = [
    TRANSCRIBE_SCRIPT,
    "--input",
    filePath,
    "--model",
    config.modelSize,
    "--device",
    config.device,
    "--language",
    config.language,
    "--compute-type",
    config.computeType,
  ];

  const { stdout, stderr, exitCode } = await spawnTranscription(args);

  if (exitCode !== 0) {
    throw new TranscriptionProcessError(exitCode, stderr);
  }

  try {
    const response = JSON.parse(stdout) as TranscriptionResponse;
    return response;
  } catch (err) {
    throw new TranscriptionParseError(err);
  }
}

function spawnTranscription(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "python3",
      args,
      {
        timeout: TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024, // 50 MB — transcriptions can be large
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      },
      (error, stdout, stderr) => {
        if (error && "killed" in error && error.killed) {
          reject(new TranscriptionTimeoutError(args[1] ?? "unknown"));
          return;
        }

        const exitCode =
          error && "code" in error ? (error.code as number | null) : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
      },
    );

    child.on("error", (err) => {
      if (err.message.includes("ENOENT")) {
        reject(
          new WhisperNotConfiguredError(),
        );
      } else {
        reject(err);
      }
    });
  });
}

export { WhisperNotConfiguredError } from "./index";
