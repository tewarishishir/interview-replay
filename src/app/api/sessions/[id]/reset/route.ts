import { and, desc, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { FALLBACK_MODEL_VERSION_PREFIX } from "@/lib/llm";
import { analyzeRequestLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import {
  assertTransitionAllowed,
  StateTransitionError,
} from "@/lib/state-machine";

/**
 * POST /api/sessions/:id/reset
 *
 * Retry step 1 — un-sticks a session whose analysis didn't produce
 * a usable report so the user can re-run analysis on the same
 * transcript without minting a new session. The client (Retry
 * button) immediately follows up with POST /analyze; this route
 * only handles the state flip + audit row so the analyze guard
 * accepts the session.
 *
 * Why this route exists:
 *   The state machine treats `failed` as a terminal-ish state because
 *   the worker pipeline writes `failed` for several genuinely-
 *   unrecoverable conditions (mid-recording crash, transcription
 *   blew up). For those, "start a new session" really is the right
 *   answer — the recording / audio is gone or corrupted.
 *
 *   But the most common `failed` path in practice is a transient
 *   LLM/analyze hiccup: the transcript is fine, the artifacts are
 *   fine, the audio is fine, only the report-generation step blew
 *   up. For that case "start a new session" is awful UX — the user
 *   would have to re-record their interview. This route is the
 *   surgical un-stuck for analysis failures specifically.
 *
 *   The route also handles the LLM-fallback path: when generation
 *   degrades into `buildFallbackReport(...)` the worker persists a
 *   stub report and lands the row in `complete` so the user has
 *   *something* to read. The report page
 *   surfaces a `FallbackRetryBanner` on top of that stub, which
 *   shares the same Retry button as `FailedPanel`. From the user's
 *   POV both flows are "the analysis didn't really produce a real
 *   report — let me retry on the same transcript". Treating only
 *   `failed` here would 409 every time the banner's button is
 *   clicked, which is exactly the bug this branch fixes.
 *
 * Behavior:
 *   - Same-origin guard + auth gate (mirrors the analyze route).
 *   - Reuses `analyzeRequestLimiter` so a burst of resets can't be
 *     used to spam the analyze pipeline either — the route that
 *     follows would be POST /analyze, which is also limited, but
 *     pinning it here too keeps the abuse window tight.
 *   - Ownership-scoped session read (filters `deleted_at IS NULL`).
 *   - Accepts `failed` unconditionally and `complete` only when the
 *     latest report row is a fallback report (model_version starts
 *     with `fallback:`). Anything else gets a 409 — a healthy
 *     `complete`, `review`, `analyzing`, etc. session has nothing
 *     to reset.
 *   - Picks the reset target:
 *       failed   + prior report → `complete` (re-analysis path)
 *       failed   + no prior     → `review`   (first-analysis path)
 *       complete + fallback     → `complete` (state already correct)
 *     The `failed` branches preserve access to any existing report
 *     by landing back on `complete` rather than `review`. The
 *     fallback branch is a no-op state-wise — the session is already
 *     where the re-analyze flow expects it (`/submit` accepts
 *     `complete`); we just need to greenlight the navigation.
 *   - Atomically: CAS the state when a flip is needed, write an
 *     audit log row in all cases.
 *   - Returns `{ ok: true, newState }` on success.
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

  // Reuse the analyze limiter rather than spinning up a dedicated
  // bucket. Reset is the immediate prelude to analyze in every
  // legitimate flow, so they share the same abuse surface — the
  // user shouldn't be able to bypass the analyze burst cap by
  // alternating reset/analyze.
  const limit = await analyzeRequestLimiter().check(userId);
  if (!limit.success) {
    const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many analysis-related requests. Try again shortly.",
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

  // Ownership-scoped read — same pattern the analyze route uses so
  // a soft-deleted or foreign session reads as 404 (no existence
  // disclosure across users). The `deleted_at IS NULL` filter is
  // load-bearing: without it a session that was soft-deleted from
  // `failed` (state moves to `deleted`, but a future code path that
  // soft-deletes WITHOUT changing state would slip through) could
  // be reset back to `review` / `complete`, effectively undoing
  // the deletion. The current delete path always flips state to
  // `deleted`, so today the `state !== "failed"` check below would
  // catch this anyway — but defense-in-depth keeps that future bug
  // from materializing.
  const [session] = await db
    .select({
      id: schema.interviewSessions.id,
      state: schema.interviewSessions.state,
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

  // Look up the latest report up front — both branches need it.
  // For `failed`, presence picks the reset target (`complete` vs
  // `review`). For `complete`, the model_version determines whether
  // this is the fallback-retry path or a healthy session that has
  // no business hitting this route.
  const [latestReport] = await db
    .select({
      id: schema.reports.id,
      modelVersion: schema.reports.modelVersion,
    })
    .from(schema.reports)
    .where(eq(schema.reports.sessionId, sessionId))
    .orderBy(desc(schema.reports.createdAt))
    .limit(1);

  const isFallbackReport =
    latestReport?.modelVersion?.startsWith(FALLBACK_MODEL_VERSION_PREFIX) ??
    false;

  if (session.state === "complete" && isFallbackReport) {
    // Fallback-retry path. The worker already landed the row in
    // `complete` (it's how the user got the stub report + the
    // FallbackRetryBanner in the first place), and the re-analyze
    // flow accepts `complete` directly. So this is a state-only
    // no-op — we just write the audit row so ops can correlate
    // "user clicked reset on a fallback" with the subsequent
    // analyze event, and respond OK so the client can navigate to
    // /submit.
    try {
      await db.insert(schema.auditLog).values({
        userId,
        eventType: "session.reset",
        eventData: {
          sessionId,
          previousState: "complete",
          newState: "complete",
          fallbackRetry: true,
        },
      });
    } catch (err) {
      console.error(
        "[POST /api/sessions/:id/reset] audit insert failed:",
        err,
      );
      return NextResponse.json(
        {
          error: "internal_error",
          message: "Couldn't reset the session. Please try again.",
        },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { ok: true, newState: "complete" as const },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (session.state !== "failed") {
    return NextResponse.json(
      {
        error: "state_mismatch",
        message:
          `Session is in state '${session.state}'; reset only applies to failed sessions.`,
      },
      { status: 409 },
    );
  }

  // `failed` branch. If a prior report exists this was a re-analysis
  // that failed — reset to `complete` so the prior report stays
  // accessible from the report page. If not, this was a first
  // analysis — reset to `review` so the user hits the standard
  // pre-analysis flow.
  const targetState = latestReport
    ? ("complete" as const)
    : ("review" as const);

  // Belt-and-suspenders state-machine guard. The check above gates
  // on `failed` already; this is the lifecycle-level guard for the
  // chosen target so a future widening of `ALLOWED_TRANSITIONS`
  // can't silently let us pick an illegal target.
  try {
    assertTransitionAllowed("failed", targetState);
  } catch (err) {
    if (err instanceof StateTransitionError) {
      return NextResponse.json(
        { error: "state_mismatch", message: err.message },
        { status: 409 },
      );
    }
    throw err;
  }

  // CAS the state flip on `failed` so a concurrent reset (or a
  // recovered worker writing `complete` out from under us) can't
  // double-trigger.
  try {
    await db.transaction(async (tx) => {
      const [advanced] = await tx
        .update(schema.interviewSessions)
        .set({ state: targetState, updatedAt: new Date() })
        .where(
          and(
            eq(schema.interviewSessions.id, sessionId),
            eq(schema.interviewSessions.userId, userId),
            eq(schema.interviewSessions.state, "failed"),
            isNull(schema.interviewSessions.deletedAt),
          ),
        )
        .returning({ id: schema.interviewSessions.id });

      if (!advanced) {
        // Someone else moved the session out of `failed` between the
        // SELECT above and the UPDATE here. Throw a sentinel so the
        // outer catch maps it to a 409 instead of a 500.
        throw new StateTransitionError("failed", targetState);
      }

      await tx.insert(schema.auditLog).values({
        userId,
        eventType: "session.reset",
        eventData: {
          sessionId,
          previousState: "failed",
          newState: targetState,
        },
      });
    });
  } catch (err) {
    if (err instanceof StateTransitionError) {
      return NextResponse.json(
        { error: "state_mismatch", message: err.message },
        { status: 409 },
      );
    }
    console.error("[POST /api/sessions/:id/reset] tx failed:", err);
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Couldn't reset the session. Please try again.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { ok: true, newState: targetState },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
