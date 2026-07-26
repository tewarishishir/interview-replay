import { and, desc, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import {
  consumeCreditsForAnalysis,
  creditsForDuration,
  DurationOutOfRangeError,
  FreeReanalysisAlreadyUsedError,
  freeReanalysisAvailable,
  hasConsumedFreeReanalysis,
  InsufficientCreditsError,
  REANALYSIS_FIXED_CREDIT_COST,
  refundConsumedCredits,
  SessionNotFoundError,
  SessionStateMismatchError,
} from "@/lib/credits";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs";
import { analyzeRequestLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { StateTransitionError } from "@/lib/state-machine";

/**
 * Maximum size we'll read off the request stream. The route
 * doesn't actually use the body (re-analysis is implicit), so
 * anything more than a few hundred bytes is suspicious. Keeps a
 * hostile client from streaming megabytes into our handler before
 * we discard them.
 */
const MAX_REQUEST_BODY_BYTES = 1024;

/**
 * POST /api/sessions/:id/analyze
 *
 * Charges credits and triggers the analyze-session worker.
 *
 *   1. Same-origin + auth + rate-limit gate (mirrors POST /api/sessions).
 *   2. Look up the session (ownership-scoped via `userId` in the
 *      WHERE) — must be in `review` (first analysis) or `complete`
 *      (re-analysis).
 *   3. Read the transcript's `duration_seconds` and compute the
 *      required credits via `creditsForDuration`. Reject 422 for
 *      anything > 120 minutes.
 *   4. Determine free-re-run eligibility: charge 0 credits only if
 *      the most recent prior report was within the 24-hour free
 *      window AND the session hasn't already burned its one free
 *      re-run (`hasConsumedFreeReanalysis`). Otherwise full price.
 *   5. Atomically deduct credits + advance the session state via
 *      `consumeCreditsForAnalysis` (FOR UPDATE on the user row).
 *      The consume call also re-checks the free invariant under
 *      the lock as a TOCTOU defense.
 *   6. Run the analyze-session pipeline inline.
 *   7. Return 202 Accepted with `{ creditsCharged, balance }`.
 */

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

  const limiter = analyzeRequestLimiter();
  const limit = await limiter.check(userId);
  if (!limit.success) {
    const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many analysis requests recently. Try again soon.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
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

  // Body-size cap. The route doesn't use the body — POST is the
  // verb because the call mutates server state, but everything
  // it needs is in the URL + session. We still honor `Content-Length`
  // so a large request returns 413 quickly. We don't drain the
  // body otherwise; the platform handles that. The check is
  // defense in depth against a hostile client that sets a huge
  // Content-Length header even when we don't read the body.
  const contentLengthHeader = h.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
      return NextResponse.json(
        { error: "payload_too_large", message: "Request body too large." },
        { status: 413 },
      );
    }
  }
  void request;

  // Ownership-scoped session read. `deleted_at IS NULL` is required
  // — a soft-deleted session must look identical to a non-existent
  // one (no information leakage about its prior existence).
  const [session] = await db
    .select({
      id: schema.interviewSessions.id,
      state: schema.interviewSessions.state,
      roundType: schema.interviewSessions.roundType,
    })
    .from(schema.interviewSessions)
    .where(
      and(
        eq(schema.interviewSessions.id, sessionId),
        eq(schema.interviewSessions.userId, userId),
        isNull(schema.interviewSessions.deletedAt),
      ),
    )
    .limit(1);

  if (!session) {
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }

  // The state guard runs again inside `consumeCreditsForAnalysis`
  // (under FOR UPDATE), so the check here is just for a fast 409
  // before we touch the transcript / report tables.
  const priorState = session.state;
  if (priorState !== "review" && priorState !== "complete") {
    return NextResponse.json(
      {
        error: "state_mismatch",
        message: `Session is in state '${priorState}'; analysis can only run from 'review' or 'complete'.`,
      },
      { status: 409 },
    );
  }

  // Transcript lookup — must exist and have a valid duration.
  const [transcript] = await db
    .select({
      durationSeconds: schema.transcripts.durationSeconds,
      transcriptionError: schema.transcripts.transcriptionError,
    })
    .from(schema.transcripts)
    .where(eq(schema.transcripts.sessionId, sessionId))
    .limit(1);

  if (!transcript) {
    return NextResponse.json(
      {
        error: "transcript_missing",
        message:
          "We don't have a transcript for this session yet. Wait for transcription to finish.",
      },
      { status: 409 },
    );
  }

  if (transcript.transcriptionError) {
    return NextResponse.json(
      {
        error: "transcript_failed",
        message:
          "Transcription failed for this session — there's no usable text to analyze.",
      },
      { status: 409 },
    );
  }

  // Look up the most recent prior report. Existence of a prior
  // report distinguishes a FIRST analysis (duration-priced) from
  // a RE-ANALYSIS (flat 1-credit price, with optional one-free
  // discount inside the 24h window). The query is cheap (single
  // row, indexed on session_id) and we need it for the free-run
  // window calculation regardless, so the same fetch services
  // both decisions.
  //
  // NOTE: destructuring `[lastReport]` yields `undefined` when no
  // rows exist (NOT `null`); the `?? null` is required for the
  // `freeReanalysisAvailable` call below, which expects null. We
  // gate `isReanalysis` on a truthy check rather than `!== null`
  // so the undefined case is correctly treated as "first run".
  const [lastReport] = await db
    .select({ createdAt: schema.reports.createdAt })
    .from(schema.reports)
    .where(eq(schema.reports.sessionId, sessionId))
    .orderBy(desc(schema.reports.createdAt))
    .limit(1);

  const isReanalysis = lastReport != null;

  // Compute base credits required. First analyses are priced by
  // duration (the standard bucket ladder); re-analyses are a flat
  // REANALYSIS_FIXED_CREDIT_COST regardless of duration — the
  // transcription cost was already sunk on the first run, so we only
  // need to cover the LLM re-call. Pricing is centralized
  // in `lib/credits/pricing.ts` so the UI and the route never
  // disagree.
  let baseCredits: number;
  if (isReanalysis) {
    baseCredits = REANALYSIS_FIXED_CREDIT_COST;
  } else {
    try {
      baseCredits = creditsForDuration(transcript.durationSeconds);
    } catch (err) {
      if (err instanceof DurationOutOfRangeError) {
        return NextResponse.json(
          {
            error: "duration_out_of_range",
            message: err.message,
          },
          { status: 422 },
        );
      }
      throw err;
    }
  }

  // Re-analysis discount: charge 0 credits ONLY when both:
  //   (a) the most recent prior report is within the 24h window, AND
  //   (b) the session has NOT already burned its one free re-run.
  //
  // The "one free re-run per session" rule exists because every
  // free re-analysis still costs us a real LLM call. Without
  // it the 24h window was an unbounded LLM-roll factory — a user
  // could spam "Re-analyze (free re-run)" after every typo edit
  // and burn LLM spend with zero credit revenue. The flat
  // 1-credit cost is the throttle for everything past the first
  // free run.
  //
  // We do BOTH a pre-flight check here (so we can hand the route
  // a clean `creditsRequired` and avoid surfacing a confusing 409
  // to the user on the common path) AND an authoritative re-check
  // inside `consumeCreditsForAnalysis` under the user-row FOR
  // UPDATE lock (TOCTOU defense for two concurrent free clicks
  // racing through this pre-flight).
  //
  // Skip the ledger lookup when there's no prior report — first
  // analysis can never be free, so the answer is fixed at false
  // and the helper would return false anyway. Avoids two count(*)
  // queries on the happy path of every brand-new session.
  const freeAlreadyUsed = isReanalysis
    ? await hasConsumedFreeReanalysis({ sessionId, userId })
    : false;
  const free = freeReanalysisAvailable({
    lastReportAt: lastReport?.createdAt ?? null,
    freeReanalysisAlreadyUsed: freeAlreadyUsed,
  });
  const creditsRequired = free ? 0 : baseCredits;

  // Atomic credit consumption + session state advance. The
  // one-free-per-session invariant is re-checked transactionally
  // (delta=0 ledger rows for this session under FOR UPDATE) so a
  // TOCTOU race on the pre-flight `freeAlreadyUsed` above can't
  // cause us to consume two free re-runs.
  let consumeResult: Awaited<ReturnType<typeof consumeCreditsForAnalysis>>;
  try {
    consumeResult = await consumeCreditsForAnalysis({
      userId,
      sessionId,
      creditsRequired,
    });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return NextResponse.json(
        {
          error: "insufficient_credits",
          message: err.message,
          required: err.required,
          available: err.available,
        },
        { status: 402 },
      );
    }
    if (err instanceof FreeReanalysisAlreadyUsedError) {
      // Lost the TOCTOU race — another request consumed the free
      // re-run between our pre-flight read and the txn. Surface
      // 409 so the client refreshes (the next render will see
      // `free=false` and offer the paid price). We deliberately
      // do NOT silently re-attempt at the paid price — that would
      // burn credits without re-confirming with the user.
      return NextResponse.json(
        {
          error: "free_reanalysis_already_used",
          message: err.message,
        },
        { status: 409 },
      );
    }
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json(
        { error: "not_found", message: "Session not found." },
        { status: 404 },
      );
    }
    if (
      err instanceof SessionStateMismatchError ||
      err instanceof StateTransitionError
    ) {
      return NextResponse.json(
        { error: "state_mismatch", message: err.message },
        { status: 409 },
      );
    }
    console.error(
      "[POST /api/sessions/:id/analyze] consume failed:",
      err,
    );
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Couldn't start analysis. Please try again.",
      },
      { status: 500 },
    );
  }

  // Run the analysis pipeline inline (fire-and-forget). The route
  // returns 202 immediately and the session detail page picks up the
  // state transition via client-side polling.
  void enqueueJob("analyze-session", async () => {
    const { runAnalyzeInline } = await import(
      "@/lib/sessions/analyze-inline"
    );
    await runAnalyzeInline({
      sessionId,
      userId,
      isFreeReanalysis: free,
      creditsCharged: creditsRequired,
    });
  });

  return NextResponse.json(
    {
      sessionId,
      creditsCharged: creditsRequired,
      isFreeReanalysis: free,
      balanceAfter: consumeResult.balanceAfter,
    },
    { status: 202 },
  );
}
