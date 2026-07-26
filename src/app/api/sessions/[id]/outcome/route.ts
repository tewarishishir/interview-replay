import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { getSession } from "@/lib/queries/sessions";
import { ipFromHeaders, outcomeWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import {
  createOutcome,
  createOutcomeBodySchema,
  deleteOutcome,
  getOutcomeForSession,
  OutcomeAlreadyExistsError,
  OutcomeNotFoundError,
  updateOutcome,
  updateOutcomeBodySchema,
} from "@/lib/sessions/outcomes";
import type { SessionOutcome } from "@/lib/db/schema";
import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";

/**
 * /api/sessions/:id/outcome
 *
 * CRUD for the user-recorded interview outcome. Four verbs:
 *
 *   POST   create a new outcome (409 if one already exists).
 *   GET    read the outcome (404 if none).
 *   PATCH  update an existing outcome (404 if none).
 *   DELETE remove the outcome (idempotent: 404 if none).
 *
 * Every write path:
 *   1. Verifies origin (CSRF defense in depth).
 *   2. Verifies the caller is a still-active signed-in user.
 *   3. Checks the per-user rate limit.
 *   4. Re-checks session ownership AND that `state = 'complete'`
 *      — outcomes are only meaningful for analyzed sessions.
 *   5. Writes the row + audit log entry inside a transaction.
 *   6. Fires a server-side analytics event (recorded only; reads,
 *      updates, and deletes are not analytics-relevant).
 *
 * The outcome row layer (`lib/sessions/outcomes.ts`) is the
 * single source of truth for SQL + audit log writes. This file
 * only handles HTTP shape / status codes / validation framing.
 */

const MAX_BODY_BYTES = 32 * 1024; // 32 KB; the schema cap is ~10.7 KB of text + a few enums.

const paramsSchema = z.object({
  id: z.string().uuid(),
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

const NOT_FOUND = (): Response =>
  NextResponse.json(
    { error: "not_found", message: "Session not found." },
    { status: 404 },
  );

const FORBIDDEN = (): Response =>
  NextResponse.json(
    { error: "forbidden", message: "Cross-origin request rejected." },
    { status: 403 },
  );

const UNAUTHORIZED = (): Response =>
  NextResponse.json(
    { error: "unauthorized", message: "You must be signed in." },
    { status: 401 },
  );

interface PreflightOk {
  ok: true;
  userId: string;
  sessionId: string;
  /**
   * `null` for read paths where we don't bother loading the row
   * (we already proved ownership in `getSession`). The write
   * paths use this to enforce the "outcome_received_at must be
   * on or after the session's createdAt" rule.
   */
  sessionCreatedAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
}

type PreflightResult = PreflightOk | { ok: false; response: Response };

/**
 * Shared front-half for every verb on this route. Returns either
 * the resolved (userId, sessionId) tuple OR the early-out response
 * that the verb handler should hand back to Next directly.
 *
 * `requireWriteState` controls whether we 409 when the session
 * isn't `complete`. GET passes `false` (a session in `analyzing`
 * shouldn't have an outcome row, but if there's somehow one
 * recorded against it we'd rather render than 409); the three
 * write verbs pass `true`.
 */
async function preflight(
  request: Request,
  context: RouteContext,
  opts: { requireWriteState: boolean; rateLimit: boolean },
): Promise<PreflightResult> {
  const h = await headers();

  if (!isSameOrigin(h)) return { ok: false, response: FORBIDDEN() };

  const userId = await getActiveUserId();
  if (!userId) return { ok: false, response: UNAUTHORIZED() };

  if (opts.rateLimit) {
    const rl = outcomeWriteLimiter();
    const limit = await rl.check(userId);
    if (!limit.success) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "rate_limited",
            message: "Too many outcome edits. Try again in a minute.",
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
        ),
      };
    }
  }

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return { ok: false, response: NOT_FOUND() };
  const { id: sessionId } = parsedParams.data;

  const row = await getSession(sessionId, userId);
  if (!row) return { ok: false, response: NOT_FOUND() };

  if (opts.requireWriteState && row.state !== "complete") {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "state_conflict",
          message:
            "Outcomes can only be recorded after a session is analyzed.",
          currentState: row.state,
        },
        { status: 409 },
      ),
    };
  }

  // Best-effort capture of the request context for the audit log.
  // `request` is the Next/Web Request; the auth route helpers use
  // `headers()` for this so we keep the same shape.
  const ipAddress = ipFromHeaders(h);
  void request;

  return {
    ok: true,
    userId,
    sessionId,
    sessionCreatedAt: row.createdAt,
    ipAddress: ipAddress === "unknown-ip" ? null : ipAddress,
    userAgent: h.get("user-agent"),
  };
}

/**
 * Cross-field check that the schema can't do on its own: a user
 * can't have heard back from the company BEFORE the interview
 * even happened. We use `session.createdAt` as the floor because
 * that's the closest stable proxy for "when the interview
 * occurred" (transcripts/reports come later in the pipeline,
 * but createdAt is the moment the user kicked off the recording).
 *
 * Returns the field-error response if the date is bad, or null
 * if it's fine. Both POST and PATCH funnel through this so the
 * rule is enforced symmetrically.
 */
function checkOutcomeReceivedAtAgainstSession(
  outcomeReceivedAtIso: string | null | undefined,
  sessionCreatedAt: Date,
): Response | null {
  if (!outcomeReceivedAtIso) return null;
  const t = Date.parse(outcomeReceivedAtIso);
  if (!Number.isFinite(t)) return null; // schema already rejects this
  // Allow same-day equality with a small skew buffer (the user
  // recording an outcome literally on the day of the interview is
  // legitimate; most "heard back" inputs come days later).
  if (t < sessionCreatedAt.getTime() - 24 * 60 * 60 * 1000) {
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Outcome body is invalid.",
        fieldErrors: {
          outcome_received_at:
            "You can't have heard back before the interview happened.",
        },
      },
      { status: 400 },
    );
  }
  return null;
}

/**
 * Read the request body as JSON, with size + content-type sanity
 * checks identical to the transcript route. Returns either the
 * parsed `unknown` value or the early-out response.
 */
async function readJsonBody(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "payload_too_large", message: "Outcome body is too large." },
        { status: 413 },
      ),
    };
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "bad_json", message: "Request body could not be read." },
        { status: 400 },
      ),
    };
  }

  if (bodyText.length > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "payload_too_large", message: "Outcome body is too large." },
        { status: 413 },
      ),
    };
  }

  try {
    return { ok: true, body: bodyText.length === 0 ? {} : JSON.parse(bodyText) };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "bad_json", message: "Request body must be valid JSON." },
        { status: 400 },
      ),
    };
  }
}

/**
 * Wire-shape response. Dates are ISO strings; the API NEVER emits
 * raw `Date` objects through `NextResponse.json` because the JSON
 * encoder's date handling differs across runtimes.
 */
function serializeOutcome(o: SessionOutcome) {
  return {
    id: o.id,
    sessionId: o.sessionId,
    outcomeType: o.outcomeType,
    outcomeReceivedAt: o.outcomeReceivedAt
      ? o.outcomeReceivedAt.toISOString()
      : null,
    recordedAt: o.recordedAt.toISOString(),
    nextRoundType: o.nextRoundType,
    feedbackReceived: o.feedbackReceived,
    reflectionNotes: o.reflectionNotes,
    wouldChange: o.wouldChange,
    askedForFeedback: o.askedForFeedback,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

/* ──────────────────────────────────────────────────────────── */
/*                              GET                              */
/* ──────────────────────────────────────────────────────────── */

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const pre = await preflight(request, context, {
    requireWriteState: false,
    rateLimit: false,
  });
  if (!pre.ok) return pre.response;

  const outcome = await getOutcomeForSession(pre.sessionId);
  if (!outcome) return NOT_FOUND();

  return NextResponse.json(
    { outcome: serializeOutcome(outcome) },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}

/* ──────────────────────────────────────────────────────────── */
/*                              POST                             */
/* ──────────────────────────────────────────────────────────── */

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const pre = await preflight(request, context, {
    requireWriteState: true,
    rateLimit: true,
  });
  if (!pre.ok) return pre.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = createOutcomeBodySchema.safeParse(body.body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path.map(String).join(".") || "_form";
      fieldErrors[k] ??= issue.message;
    }
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Outcome body is invalid.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  if (pre.sessionCreatedAt) {
    const dateError = checkOutcomeReceivedAtAgainstSession(
      parsed.data.outcome_received_at,
      pre.sessionCreatedAt,
    );
    if (dateError) return dateError;
  }

  let created;
  try {
    created = await createOutcome({
      sessionId: pre.sessionId,
      body: parsed.data,
      audit: {
        userId: pre.userId,
        ipAddress: pre.ipAddress,
        userAgent: pre.userAgent,
      },
    });
  } catch (err) {
    if (err instanceof OutcomeAlreadyExistsError) {
      return NextResponse.json(
        {
          error: "outcome_already_exists",
          message: "Outcome already recorded. Use PATCH to update it.",
        },
        { status: 409 },
      );
    }
    throw err;
  }

  // Server-side analytics. We compute `daysSinceSessionCompleted`
  // here (not on the client) so the value is authoritative across
  // the user's clock skew + timezone. The session's `created_at`
  // is the closest stable proxy for "when the analysis became
  // visible"; we don't track per-state-transition timestamps in
  // the DB so this is deliberate (the alternative would be a
  // schema add we don't otherwise need).
  const session = await getSession(pre.sessionId, pre.userId);
  const daysSinceCompleted = session
    ? Math.max(
        0,
        Math.floor(
          (Date.now() - session.createdAt.getTime()) / (24 * 60 * 60 * 1000),
        ),
      )
    : 0;

  trackServerEvent({
    distinctId: pre.userId,
    event: ANALYTICS_EVENTS.outcomeRecorded,
    properties: {
      outcome_type: created.outcomeType,
      days_since_session_completed: daysSinceCompleted,
      has_feedback_received: created.feedbackReceived !== null,
      has_reflection_notes: created.reflectionNotes !== null,
      has_would_change: created.wouldChange !== null,
    },
  });

  return NextResponse.json(
    { outcome: serializeOutcome(created) },
    {
      status: 201,
      headers: { "Cache-Control": "no-store, must-revalidate" },
    },
  );
}

/* ──────────────────────────────────────────────────────────── */
/*                             PATCH                             */
/* ──────────────────────────────────────────────────────────── */

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const pre = await preflight(request, context, {
    requireWriteState: true,
    rateLimit: true,
  });
  if (!pre.ok) return pre.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = updateOutcomeBodySchema.safeParse(body.body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path.map(String).join(".") || "_form";
      fieldErrors[k] ??= issue.message;
    }
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Outcome body is invalid.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  // Reject empty PATCH bodies. A PATCH that's "set nothing" is
  // almost always a client bug (a stale form save or a misfire);
  // 400 surfaces it instead of writing a no-op audit entry.
  const hasAnyKey = Object.values(parsed.data).some((v) => v !== undefined);
  if (!hasAnyKey) {
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Outcome PATCH body had no fields to update.",
      },
      { status: 400 },
    );
  }

  if (pre.sessionCreatedAt) {
    const dateError = checkOutcomeReceivedAtAgainstSession(
      parsed.data.outcome_received_at,
      pre.sessionCreatedAt,
    );
    if (dateError) return dateError;
  }

  let updated;
  try {
    updated = await updateOutcome({
      sessionId: pre.sessionId,
      body: parsed.data,
      audit: {
        userId: pre.userId,
        ipAddress: pre.ipAddress,
        userAgent: pre.userAgent,
      },
    });
  } catch (err) {
    if (err instanceof OutcomeNotFoundError) {
      return NOT_FOUND();
    }
    throw err;
  }

  return NextResponse.json(
    { outcome: serializeOutcome(updated) },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}

/* ──────────────────────────────────────────────────────────── */
/*                            DELETE                             */
/* ──────────────────────────────────────────────────────────── */

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const pre = await preflight(request, context, {
    requireWriteState: true,
    rateLimit: true,
  });
  if (!pre.ok) return pre.response;

  const result = await deleteOutcome({
    sessionId: pre.sessionId,
    audit: {
      userId: pre.userId,
      ipAddress: pre.ipAddress,
      userAgent: pre.userAgent,
    },
  });

  if (!result.deleted) return NOT_FOUND();

  return NextResponse.json(
    { ok: true, previousOutcomeType: result.previousOutcomeType },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}
