import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import {
  chargeTranscriptionFeeAndDelete,
  SessionNotFoundError,
  transcriptionFeeForDelete,
} from "@/lib/credits";
import { db, schema } from "@/lib/db";
import { getSession } from "@/lib/queries/sessions";
import { sessionDeleteLimiter, sessionPollLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { StateTransitionError } from "@/lib/state-machine";

/**
 * GET /api/sessions/:id
 *
 * Lightweight polling endpoint used by the recorder UI to wait for
 * the transcription job to flip the row to `state = 'review'`.
 *
 * Authorization:
 *   - Same-origin (defense-in-depth on top of the Auth.js cookie's
 *     SameSite=lax setting).
 *   - Active user (revocation check), via `getActiveUserId`.
 *   - Ownership-scoped read: `getSession` returns null both for
 *     "no such row" and "owned by another user".
 *
 * The response is intentionally narrow — `id`, `state`, plus a
 * couple of header-friendly fields the recorder is allowed to know
 * about. Anything richer should go through dedicated review/report
 * endpoints, not this hot poll.
 *
 * `Cache-Control: no-store` prevents the browser or any intermediary
 * from caching this response — the whole point of the poll is to
 * see fresh state.
 */

const paramsSchema = z.object({
  id: z.string().uuid(),
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(
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

  // The recorder polls this every 3s while waiting for transcription;
  // a runaway loop or a stack of open tabs could otherwise hammer the
  // DB indefinitely. 240/min per user is well above legitimate use.
  const rl = sessionPollLimiter();
  const limit = await rl.check(userId);
  if (!limit.success) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many polling requests. Slow down and try again shortly.",
      },
      {
        status: 429,
        headers: {
          "Retry-After": Math.max(
            1,
            Math.ceil((limit.reset - Date.now()) / 1000),
          ).toString(),
          "Cache-Control": "no-store",
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

  const row = await getSession(parsed.data.id, userId);
  if (!row) {
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }

  // The recorder polls this while waiting for transcription. Once
  // we land in `review`, surface whether the transcript came back
  // with a `transcription_error` so the recorder's redirect target
  // can show the correct banner. We only do the extra read for
  // the states where it's meaningful — the hot path during recording
  // stays a single SELECT.
  let transcriptionError: string | null = null;
  if (row.state === "review" || row.state === "failed") {
    const [t] = await db
      .select({
        transcriptionError: schema.transcripts.transcriptionError,
      })
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, row.id))
      .limit(1);
    transcriptionError = t?.transcriptionError ?? null;
  }

  return NextResponse.json(
    {
      session: {
        id: row.id,
        state: row.state,
        companyName: row.companyName,
        roleTitle: row.roleTitle,
        updatedAt: row.updatedAt.toISOString(),
        transcriptionError,
      },
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store, must-revalidate",
      },
    },
  );
}

/**
 * DELETE /api/sessions/:id
 *
 * Soft-deletes a session: state transitions to `deleted` and
 * `deleted_at` is stamped. The retention sweeper later hard-purges
 * the row + audio + transcript per the privacy SLA.
 *
 * Billing:
 *   When the session was already transcribed (state = `review`) but
 *   the user bails out before paying for analysis, we still charge a
 *   small "transcription fee" — the transcription service has been called and we need
 *   to recover that cost. The fee + the soft-delete + the audit log
 *   row are all written in one transaction inside
 *   `chargeTranscriptionFeeAndDelete` so the user never sees a
 *   debited balance against a still-active session, and the API
 *   surface returns the actual amount charged so the UI can
 *   surface a "X credit charged" confirmation.
 *
 *   Sessions in earlier states (`created`, `recording`,
 *   `transcribing`) are NOT charged — no transcription value was
 *   delivered. Sessions in `analyzing` / `complete` are also NOT
 *   charged — the analyze consume already paid for the full
 *   pipeline including STT.
 *
 * Authorization mirrors GET — same-origin guard + auth gate +
 * ownership-scoped lookup. We additionally re-check the session
 * exists with a state-machine guard so a state that's somehow
 * already `deleted` returns 200 (idempotent) instead of crashing.
 */
export async function DELETE(
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

  // Per-user delete throttle. Soft-delete is idempotent so a runaway
  // loop won't double-charge the fee, but it can still hammer the
  // audit table and the user-row FOR UPDATE inside the consume
  // transaction. Keep abuse bounded.
  const rl = sessionDeleteLimiter();
  const limit = await rl.check(userId);
  if (!limit.success) {
    const retryAfter = Math.max(
      1,
      Math.ceil((limit.reset - Date.now()) / 1000),
    );
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many delete requests. Try again shortly.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
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
  const sessionId = parsed.data.id;

  // Pre-flight ownership-scoped read. We could rely entirely on the
  // re-read inside `chargeTranscriptionFeeAndDelete`, but doing one
  // extra cheap SELECT here lets us return the no-charge 404 path
  // without spinning up a write transaction. Also gives us the
  // current state for the fee calculation.
  const row = await getSession(sessionId, userId);
  if (!row) {
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }

  if (row.state === "deleted") {
    // Idempotent: the user double-clicked, or two tabs raced.
    // Mirror the legacy response shape so existing callers don't
    // break, while including the new `creditsCharged: 0` field.
    return NextResponse.json(
      { ok: true, alreadyDeleted: true, creditsCharged: 0 },
      { status: 200 },
    );
  }

  // The fee is gated on BOTH state and recording duration — short
  // (test / accidental) recordings are absorbed even from `review`.
  // We only need the duration when the state could plausibly trigger
  // a charge, so skip the extra SELECT in the common no-charge case.
  // The fee helper re-applies its own state guard, so passing a
  // duration unconditionally is fine; this is purely a perf shortcut.
  let durationSeconds: number | null = null;
  if (row.state === "review") {
    const [t] = await db
      .select({ durationSeconds: schema.transcripts.durationSeconds })
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, sessionId))
      .limit(1);
    durationSeconds = t?.durationSeconds ?? null;
  }

  // Compute the fee from the state + duration we just read. The
  // helper re-reads state inside the txn so this value can drift
  // safely — it's an upper bound on what we'll attempt to charge.
  // The actual charged amount comes back in the response.
  const feeRequested = transcriptionFeeForDelete(row.state, durationSeconds);

  let result: Awaited<ReturnType<typeof chargeTranscriptionFeeAndDelete>>;
  try {
    result = await chargeTranscriptionFeeAndDelete({
      userId,
      sessionId,
      creditsRequired: feeRequested,
    });
  } catch (err) {
    if (err instanceof StateTransitionError) {
      return NextResponse.json(
        { error: "state_mismatch", message: err.message },
        { status: 409 },
      );
    }
    if (err instanceof SessionNotFoundError) {
      // The session was deleted (or its owner cleared) between the
      // pre-flight SELECT above and the transaction. Same 404 the
      // pre-flight returns so existence isn't disclosed.
      return NextResponse.json(
        { error: "not_found", message: "Session not found." },
        { status: 404 },
      );
    }
    console.error(
      "[DELETE /api/sessions/:id] charge + delete failed:",
      err,
    );
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Couldn't delete the session. Please try again.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      alreadyDeleted: !result.applied,
      creditsCharged: result.creditsCharged,
      balanceAfter: result.balanceAfter,
      previousState: result.previousState,
    },
    { status: 200 },
  );
}
