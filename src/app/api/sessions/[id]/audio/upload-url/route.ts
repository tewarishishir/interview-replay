import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { getSession } from "@/lib/queries/sessions";
import { audioLifecycleLimiter, ipFromHeaders } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { StorageNotConfiguredError } from "@/lib/storage";
import { audioKey } from "@/lib/storage/keys";
import { signFileToken } from "@/lib/storage/signed-url";
import {
  rollbackRecordingStart,
  SessionAdvanceError,
  startRecording,
} from "@/lib/sessions/audio";

/**
 * POST /api/sessions/:id/audio/upload-url
 *
 * Mints a signed upload token URL the recorder uses to upload the
 * candidate's audio blob directly to local storage.
 *
 * Pipeline:
 *   1. Same-origin guard (defense-in-depth on top of SameSite=lax).
 *   2. Active-user check (revocation-aware).
 *   3. Per-user rate limit (audio lifecycle bucket).
 *   4. Param parse (UUID).
 *   5. Ownership check via `getSession` — null for "doesn't exist"
 *      and "belongs to someone else", same 404 for both.
 *   6. State transition `created → recording`. Done in one atomic
 *      UPDATE; concurrent advance returns 409.
 *   7. Mint key + sign token. The key includes a fresh UUID per
 *      call, so a retry that lands on this code path would emit a
 *      brand new key — the previous one will be the orphan to clean
 *      up via lifecycle policy.
 *   8. If token generation throws AFTER the state move, roll the row
 *      back to `created` so the user isn't bricked into a
 *      `recording` state with no upload URL.
 *   9. Return `{ url, key, expiresAt, requiredHeaders }`. The
 *      `requiredHeaders` map is the Content-Type the browser must
 *      send verbatim with its PUT, so the client doesn't have to
 *      branch on env.
 */

const paramsSchema = z.object({
  id: z.string().uuid(),
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(
  _request: Request,
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

  // Per-user rate limit. Keyed by userId because the caller is
  // authenticated; per-IP would unfairly throttle multiple users
  // behind a shared egress (offices, VPNs, mobile carriers).
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

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }
  const { id: sessionId } = parsed.data;

  const ipAddress = ipFromHeaders(h);
  const userAgent = h.get("user-agent");

  // Ownership check. We re-read the row (one indexed PK lookup) so
  // we can return 404 on missing/foreign rows BEFORE attempting the
  // state-guarded UPDATE. The UPDATE alone would return 0 rows in
  // both cases and force us to disambiguate, which is uglier.
  const row = await getSession(sessionId, userId);
  if (!row) {
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }

  // State guard. The transition itself is atomic in `startRecording`;
  // this pre-check lets us return a tailored error — or, for the
  // upload-retry case, auto-recover before the caller sees a 409.
  if (row.state !== "created") {
    // Special case: session is in `recording` with no completed
    // audio_files row. This means the upload failed after token generation
    // (network error, browser crash) and the client
    // is retrying. Reset to `created` so a fresh token can be
    // issued — the user's recording blob is still in browser memory.
    if (row.state === "recording") {
      const [existingAudio] = await db
        .select({ id: schema.audioFiles.id })
        .from(schema.audioFiles)
        .where(eq(schema.audioFiles.sessionId, sessionId))
        .limit(1);

      if (!existingAudio) {
        // No audio file yet — safe to roll back and re-issue token.
        try {
          await rollbackRecordingStart({
            sessionId,
            userId,
            ipAddress,
            userAgent,
          });
        } catch (rollbackErr) {
          console.error(
            "[POST /api/sessions/:id/audio/upload-url] auto-reset rollback failed:",
            rollbackErr,
          );
          return NextResponse.json(
            {
              error: "internal_error",
              message: "Could not reset session for retry. Please try again.",
            },
            { status: 500 },
          );
        }
        // Fall through — session is now `created`, proceed to token generation.
      } else {
        // Audio file already exists; the upload completed (or is in
        // flight on another tab). Reject so we don't overwrite it.
        return NextResponse.json(
          {
            error: "state_conflict",
            message: "Audio for this session has already been uploaded.",
            currentState: row.state,
          },
          { status: 409 },
        );
      }
    } else {
      return NextResponse.json(
        {
          error: "state_conflict",
          message: "This session is no longer eligible for upload.",
          currentState: row.state,
        },
        { status: 409 },
      );
    }
  }

  // Mint the key first. `audioKey` is pure: it just rejects
  // malformed userId/sessionId UUIDs, so a key that won't exist post
  // state-advance will fail here with no DB write.
  let key: string;
  try {
    key = audioKey(userId, sessionId);
  } catch (err) {
    console.error(
      "[POST /api/sessions/:id/audio/upload-url] audioKey failed:",
      err,
    );
    return NextResponse.json(
      { error: "internal_error", message: "Could not allocate upload key." },
      { status: 500 },
    );
  }

  // Atomic state advance. If a parallel request beat us to it the
  // UPDATE matches zero rows and `startRecording` throws.
  try {
    await startRecording({ sessionId, userId, ipAddress, userAgent });
  } catch (err) {
    if (err instanceof SessionAdvanceError) {
      return NextResponse.json(
        {
          error: "state_conflict",
          message: "Session state changed before recording could start.",
        },
        { status: 409 },
      );
    }
    console.error(
      "[POST /api/sessions/:id/audio/upload-url] startRecording failed:",
      err,
    );
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Could not start recording. Please try again.",
      },
      { status: 500 },
    );
  }

  // Now generate an upload token. If THIS step fails, we must roll
  // the session row back to `created` — otherwise the user is stuck
  // in `recording` forever with no way to upload, and the next
  // /upload-url retry would 409 on the state guard.
  try {
    const token = signFileToken(key, 3600);
    const uploadUrl = `/api/storage/upload?token=${token}`;
    return NextResponse.json(
      {
        url: uploadUrl,
        key,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        requiredHeaders: { "Content-Type": "audio/webm" },
      },
      { status: 201 },
    );
  } catch (err) {
    try {
      await rollbackRecordingStart({
        sessionId,
        userId,
        ipAddress,
        userAgent,
      });
    } catch (rollbackErr) {
      console.error(
        "[POST /api/sessions/:id/audio/upload-url] token generation rollback failed:",
        rollbackErr,
      );
    }

    if (err instanceof StorageNotConfiguredError) {
      return NextResponse.json(
        {
          error: err.code,
          message:
            "Audio uploads are not configured in this environment. " +
            "Contact the operator.",
        },
        { status: err.status },
      );
    }
    console.error(
      "[POST /api/sessions/:id/audio/upload-url] token generation failed:",
      err,
    );
    return NextResponse.json(
      { error: "internal_error", message: "Could not generate upload URL." },
      { status: 500 },
    );
  }
}
