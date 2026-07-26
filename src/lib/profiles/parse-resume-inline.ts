import "server-only";

import { deleteFile } from "@/lib/storage/delete";

import {
  extractResumeText,
  markResumeParseCompleted,
  markResumeParseFailed,
  markResumeParseProcessing,
  ResumeParseLlmNotConfiguredError,
  ResumeParseValidationError,
} from "./parse-resume";

/**
 * In-process resume-parse pipeline (mark processing → extract text →
 * call the LLM → persist draft → delete stored file). Runs
 * sequentially in the caller's request handler as a fire-and-forget
 * async job.
 *
 * The route already has the PDF bytes in memory, so we accept them
 * as an argument rather than re-reading from storage.
 *
 * Lives in its own file so importing it dynamically from the route
 * keeps the LLM SDK + `pdf-parse` (both heavy) out of the
 * main request bundle until this fallback is actually hit.
 *
 * Error contract:
 *   - On success: returns normally. The job row is `completed`,
 *     the draft is persisted, and the stored file has been deleted.
 *   - On failure: BEST-EFFORT marks the job `failed` (so the
 *     polling endpoint reports an actionable error to the client)
 *     and best-effort deletes the stored file, then re-throws so
 *     the route can decide how to respond.
 */
export async function runParseResumeInline(args: {
  jobId: string;
  userId: string;
  s3Key: string;
  bytes: Uint8Array;
}): Promise<void> {
  try {
    await markResumeParseProcessing(args.jobId, args.userId);

    const { text } = await extractResumeText(args.bytes);
    if (text.trim().length === 0) {
      throw new Error(
        "extracted resume text was empty (likely a scanned image PDF)",
      );
    }


    await markResumeParseCompleted({
      jobId: args.jobId,
      userId: args.userId,
      draft,
    });

    // Hard-delete the stored file on success — same policy as the
    // worker. The PDF is no longer useful once the draft is on
    // the row, and the spec requires deletion before save.
    try {
      await deleteFile(args.s3Key);
    } catch (cleanupErr) {
      console.warn(
        "[runParseResumeInline] post-success deleteFile threw:",
        cleanupErr,
      );
    }
  } catch (err) {
    // Mirror the worker's `onFailure` so any error along the
    // inline path leaves the system in a sane state: row →
    // `failed` with an actionable message + stored file reaped.
    const code =
      err instanceof ResumeParseLlmNotConfiguredError
        ? "resume_parse_llm_not_configured"
        : err instanceof ResumeParseValidationError
          ? "resume_parse_invalid_output"
          : "resume_parse_failed";
    const message =
      err instanceof Error
        ? `${code}: ${err.message}`
        : `${code}: unknown error`;

    try {
      await markResumeParseFailed({
        jobId: args.jobId,
        userId: args.userId,
        errorMessage: message,
      });
    } catch (failureErr) {
      console.error(
        `[runParseResumeInline] markResumeParseFailed threw for job=${args.jobId}:`,
        failureErr,
      );
    }

    try {
      await deleteFile(args.s3Key);
    } catch (cleanupErr) {
      console.warn(
        "[runParseResumeInline] post-failure deleteFile threw:",
        cleanupErr,
      );
    }

    throw err;
  }
}
