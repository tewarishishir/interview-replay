import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { getSession } from "@/lib/queries/sessions";
import { sessionReviewWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import {
  TRANSCRIPT_EDITABLE_STATES,
  transcriptEditBodySchema,
  updateTranscriptEdits,
} from "@/lib/sessions/transcript-edits";

/**
 * PATCH /api/sessions/:id/transcript
 *
 * Body: { edited_text: string }
 *
 * Persists the candidate's transcript edits. Same auth/origin/state
 * shape as the audio routes. Two non-obvious points:
 *
 *   1. State guard. The transcript is editable in `review` (the
 *      pre-analysis cleanup screen) AND in `complete` (the
 *      post-analysis "edit text & re-analyze" screen). The
 *      `analyzing` state is the one we MUST block — letting an
 *      edit land mid-LLM-call would leave the report grounded
 *      against text the model never saw. Earlier states
 *      (`recording`, `transcribing`) can't have a transcript row
 *      yet, so the response is 409 with the current state
 *      surfaced.
 *
 *   2. We only write `edited_text`. `raw_text` and `redacted_text`
 *      stay immutable for forensics; the `updateTranscriptEdits`
 *      helper enforces this in code (we never reach for those columns).
 */

const MAX_BODY_BYTES = 256 * 1024; // 256 KB; transcript schema cap is 250k chars.

const paramsSchema = z.object({
  id: z.string().uuid(),
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(
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

  const rl = sessionReviewWriteLimiter();
  const limit = await rl.check(userId);
  if (!limit.success) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many edits. Try again in a minute.",
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

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "Transcript edit is too large." },
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
      { error: "payload_too_large", message: "Transcript edit is too large." },
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

  const parsedBody = transcriptEditBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsedBody.error.issues) {
      const k = issue.path.map(String).join(".") || "_form";
      fieldErrors[k] ??= issue.message;
    }
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Transcript edit body is invalid.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  const row = await getSession(sessionId, userId);
  if (!row) {
    // Same shape as the rest of the API: never disclose
    // "exists, but not yours" vs. "doesn't exist".
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }

  if (
    !(TRANSCRIPT_EDITABLE_STATES as readonly string[]).includes(row.state)
  ) {
    return NextResponse.json(
      {
        error: "state_conflict",
        message:
          row.state === "analyzing"
            ? "Transcript is locked while analysis is running. Wait for it to finish, then edit and re-analyze from the report page."
            : "Transcript can only be edited after the recording is processed.",
        currentState: row.state,
      },
      { status: 409 },
    );
  }

  const result = await updateTranscriptEdits({
    sessionId,
    userId,
    editedText: parsedBody.data.edited_text,
  });

  if (result.status === "not_found") {
    // Same shape as the rest of the API: never disclose
    // "exists, but not yours" vs. "doesn't exist".
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }

  if (result.status === "state_conflict") {
    // The pre-check above saw an editable state, but the
    // transactional UPDATE didn't — i.e. a concurrent advance
    // landed in the gap (almost always a re-analyze that just
    // moved the session into `analyzing`). Look up the current
    // state for a useful error payload; if the row's gone too,
    // surface the conflict generically.
    const fresh = await getSession(sessionId, userId);
    return NextResponse.json(
      {
        error: "state_conflict",
        message: fresh
          ? "Transcript is locked while analysis is running. Try again once it finishes."
          : "Transcript edit conflicted with a concurrent change.",
        currentState: fresh?.state ?? null,
      },
      { status: 409 },
    );
  }

  const updated = result.transcript;
  return NextResponse.json(
    {
      transcript: {
        id: updated.id,
        sessionId: updated.sessionId,
        rawText: updated.rawText,
        redactedText: updated.redactedText,
        editedText: updated.editedText,
        redactionCount: updated.redactionCount,
        wordCount: updated.wordCount,
        fillerWordCount: updated.fillerWordCount,
        durationSeconds: updated.durationSeconds,
        transcriptionError: updated.transcriptionError,
        updatedAt: updated.updatedAt.toISOString(),
      },
    },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}
