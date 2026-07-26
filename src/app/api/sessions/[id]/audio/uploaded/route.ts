import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { persistTranscriptAndAdvance } from "@/lib/sessions/transcribe";
import { getSession } from "@/lib/queries/sessions";
import { audioLifecycleLimiter, ipFromHeaders } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { StorageNotConfiguredError } from "@/lib/storage";
import { fileExists } from "@/lib/storage/exists";
import {
  DuplicateAudioFileError,
  finalizeUpload,
  SessionAdvanceError,
} from "@/lib/sessions/audio";

const MAX_AUDIO_FILE_BYTES = 500 * 1024 * 1024; // 500 MB

const audioUploadedBodySchema = z.object({
  key: z.string().min(1),
  file_size_bytes: z.number().int().positive().max(MAX_AUDIO_FILE_BYTES),
  duration_seconds: z.number().positive().max(28800),
});

function parseAudioKey(key: string): { userId: string; sessionId: string } | null {
  const match = key.match(/^audio\/([^/]+)\/([^/]+)\/[^/]+\.webm$/);
  if (!match) return null;
  return { userId: match[1], sessionId: match[2] };
}

/**
 * POST /api/sessions/:id/audio/uploaded
 *
 * Body: { key, file_size_bytes, duration_seconds }
 *
 * The client calls this after a successful upload to storage, telling
 * us "the blob is up; please pick it up and transcribe it". We:
 *
 *   1. Same-origin / auth / rate-limit / param checks (boilerplate).
 *   2. Validate the body against `audioUploadedBodySchema`.
 *   3. Validate the `key` shape against the strict regex in
 *      `parseAudioKey`. The key MUST encode (a) the same userId
 *      from the auth context, (b) the same sessionId from the
 *      URL. This is the single guard that prevents a client from
 *      uploading to a key we minted for another session and then
 *      claiming it for the current one.
 *   4. Check the storage object so we don't take the client's word
 *      that the upload happened. A malicious caller could otherwise
 *      skip the actual upload, flip the session into `transcribing`,
 *      and either stall it forever or burn worker budget.
 *   5. Atomic UPDATE `recording → transcribing` + INSERT
 *      `audio_files` in one transaction (`finalizeUpload`).
 *   6. Run the transcription pipeline inline. If it fails, we still
 *      return 202 (DB state is correct) with a transcription error
 *      so the user can type/paste their transcript manually.
 */

const MAX_BODY_BYTES = 4 * 1024;

/**
 * Tolerance between the client-reported byte size and the
 * server-observed storage size. Different MediaRecorder builds
 * occasionally compute Blob.size slightly off from what storage sees
 * after write; a small absolute fudge keeps honest
 * clients from getting bounced. Larger discrepancies are an attack
 * or a bug worth surfacing.
 */
const SIZE_MISMATCH_TOLERANCE_BYTES = 1024;

const paramsSchema = z.object({
  id: z.string().uuid(),
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const h = await headers();

  if (!isSameOrigin(h)) {
    return NextResponse.json(
      { error: "forbidden", message: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  const userId = await getActiveUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "You must be signed in." },
      { status: 401 },
    );
  }

  const rl = audioLifecycleLimiter();
  const limit = await rl.check(userId);
  if (!limit.success) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many recording requests. Try again in a minute.",
      },
      {
        status: 429,
        headers: {
          "Retry-After": Math.max(
            1,
            Math.ceil((limit.reset - Date.now()) / 1000),
          ).toString(),
        },
      },
    );
  }

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }
  const { id: sessionId } = parsedParams.data;

  const ipAddress = ipFromHeaders(h);
  const userAgent = h.get("user-agent");

  // Body parse + size cap.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "Request body is too large." },
      { status: 413 },
    );
  }
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return NextResponse.json(
      { error: "bad_json", message: "Request body could not be read." },
      { status: 400 },
    );
  }
  if (bodyText.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "Request body is too large." },
      { status: 413 },
    );
  }

  let raw: unknown;
  try {
    raw = bodyText.length === 0 ? {} : JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { error: "bad_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsedBody = audioUploadedBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsedBody.error.issues) {
      const k = issue.path.map(String).join(".") || "_form";
      fieldErrors[k] ??= issue.message;
    }
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Invalid upload-completion payload.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  const { key, file_size_bytes, duration_seconds } = parsedBody.data;

  // Strict key validation. The client could have uploaded to a key
  // we never minted (or one minted for a different session/user).
  // Drop those before touching the DB.
  const parsedKey = parseAudioKey(key);
  if (!parsedKey) {
    return NextResponse.json(
      { error: "invalid_key", message: "Upload key is malformed." },
      { status: 400 },
    );
  }
  if (parsedKey.userId !== userId || parsedKey.sessionId !== sessionId) {
    // The key encodes a different (user, session) pair than the
    // request context. Either an attempt to claim someone else's
    // upload or a client bug rebroadcasting a stale key.
    return NextResponse.json(
      { error: "key_mismatch", message: "Upload key does not match session." },
      { status: 403 },
    );
  }

  // Ownership pre-check (mirrors upload-url). Returns 404 for
  // missing/foreign sessions without disclosing the difference.
  const row = await getSession(sessionId, userId);
  if (!row) {
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }

  if (row.state !== "recording") {
    return NextResponse.json(
      {
        error: "state_conflict",
        message:
          row.state === "transcribing"
            ? "This recording was already finalized."
            : "Session is not in the recording state.",
        currentState: row.state,
      },
      { status: 409 },
    );
  }

  // Verify the object actually exists in storage. A client that skips
  // the upload and calls /uploaded directly would otherwise advance
  // the session to `transcribing` and stall forever. We do this
  // BEFORE the state advance so a missing object leaves the row in
  // `recording` and a retry remains possible.
  let serverObservedSize: number | null;
  try {
    const meta = await fileExists(key);
    if (!meta.exists) {
      return NextResponse.json(
        {
          error: "object_missing",
          message:
            "We could not find the uploaded recording in storage. " +
            "Please retry the upload.",
        },
        { status: 409 },
      );
    }
    serverObservedSize = meta.size ?? null;
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) {
      return NextResponse.json(
        {
          error: err.code,
          message:
            "Audio storage is not configured in this environment. " +
            "Contact the operator.",
        },
        { status: err.status },
      );
    }
    console.error(
      "[POST /api/sessions/:id/audio/uploaded] storage check failed:",
      err,
    );
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message: "Audio storage is temporarily unavailable. Please retry.",
      },
      { status: 503 },
    );
  }

  // Enforce the absolute size ceiling using the server-observed
  // storage size, which we trust over the client-reported value.
  // This is the second line of defence after the schema cap on
  // `file_size_bytes`: even if a client bypassed the schema by
  // directly uploading and lying about the size in the body, the
  // existence check here catches the real size before we enqueue
  // the transcription job.
  if (
    typeof serverObservedSize === "number" &&
    serverObservedSize > MAX_AUDIO_FILE_BYTES
  ) {
    return NextResponse.json(
      {
        error: "file_too_large",
        message:
          `Recording exceeds the maximum allowed size of ${MAX_AUDIO_FILE_BYTES / (1024 * 1024)} MB. ` +
          "Please record a shorter session and try again.",
      },
      { status: 413 },
    );
  }

  // Catch grossly mismatched sizes. We trust the server-observed
  // length over the client-reported one; the body field is then
  // recorded for diagnostics but never used as authority.
  if (
    typeof serverObservedSize === "number" &&
    Math.abs(serverObservedSize - file_size_bytes) >
      SIZE_MISMATCH_TOLERANCE_BYTES
  ) {
    return NextResponse.json(
      {
        error: "size_mismatch",
        message:
          "Reported size does not match the uploaded object. " +
          "Please retry the upload.",
      },
      { status: 409 },
    );
  }

  const trustedFileSize =
    typeof serverObservedSize === "number"
      ? serverObservedSize
      : file_size_bytes;

  let audioFileId: string;
  try {
    const result = await finalizeUpload({
      sessionId,
      userId,
      s3Key: key,
      fileSizeBytes: trustedFileSize,
      durationSeconds: duration_seconds,
      ipAddress,
      userAgent,
    });
    audioFileId = result.audioFile.id;
  } catch (err) {
    if (err instanceof DuplicateAudioFileError) {
      return NextResponse.json(
        {
          error: "audio_already_uploaded",
          message: "This session already has an uploaded recording.",
        },
        { status: 409 },
      );
    }
    if (err instanceof SessionAdvanceError) {
      return NextResponse.json(
        {
          error: "state_conflict",
          message: "Session state changed before upload could be finalized.",
        },
        { status: 409 },
      );
    }
    console.error(
      "[POST /api/sessions/:id/audio/uploaded] finalizeUpload failed:",
      err,
    );
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Could not finalize upload. Please try again.",
      },
      { status: 500 },
    );
  }

  // Run transcription inline. Dynamic import keeps transcription
  // deps out of the main bundle.
  try {
    const { runTranscribeInline } = await import(
      "@/lib/sessions/transcribe-inline"
    );
    const inline = await runTranscribeInline({
      sessionId,
      audioFileId,
      s3Key: key,
      durationSeconds: duration_seconds,
      userId,
    });
    return NextResponse.json(
      {
        sessionId,
        audioFileId,
        state: "review",
        transcriptionError: inline.transcriptionError
          ? "inline_transcription_error"
          : null,
      },
      { status: 202 },
    );
  } catch (inlineErr) {
    console.error(
      "[POST /api/sessions/:id/audio/uploaded] inline transcription failed:",
      inlineErr,
    );
    try {
      await persistTranscriptAndAdvance({
        sessionId,
        audioFileId,
        durationSeconds: duration_seconds,
        processed: null,
        transcriptionError:
          "We couldn't auto-transcribe your recording. Ensure " +
          "faster-whisper is installed and WHISPER_MODEL_SIZE is " +
          "set in .env.local and try again. " +
          "You can still type or paste your transcript below " +
          "and continue.",
        userId,
      });
      return NextResponse.json(
        {
          sessionId,
          audioFileId,
          state: "review",
          transcriptionError: "worker_unavailable",
        },
        { status: 202 },
      );
    } catch (fallbackErr) {
      console.error(
        "[POST /api/sessions/:id/audio/uploaded] transcription fallback failed:",
        fallbackErr,
      );
    }
  }

  return NextResponse.json(
    {
      sessionId,
      audioFileId,
      state: "transcribing",
    },
    { status: 202 },
  );
}
