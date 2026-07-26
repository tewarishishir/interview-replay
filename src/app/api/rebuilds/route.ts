import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { and, eq } from "drizzle-orm";

import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { getActiveUserId } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { getSession } from "@/lib/queries/sessions";
import { rebuildWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import {
  createRebuild,
  createRebuildBodySchema,
  findInProgressRebuildForImprovement,
  listRebuilds,
  listRebuildsQuerySchema,
  toRebuildDto,
} from "@/lib/rebuilds";

/**
 * /api/rebuilds — list and create.
 *
 * Both verbs:
 *   1. Verify origin (CSRF defense in depth).
 *   2. Verify the caller is a still-active signed-in user.
 *   3. (POST) Check the per-user write rate limit.
 *   4. (POST) Validate body with `createRebuildBodySchema` and
 *      verify any pinned source session belongs to the caller
 *      AND is in state='complete'.
 *   5. (POST) Insert the row, fire the analytics event.
 */

const MAX_BODY_BYTES = 16 * 1024;

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

/* ──────────────────────────────────────────────────────────── */
/*                              GET                              */
/* ──────────────────────────────────────────────────────────── */

export async function GET(request: Request): Promise<Response> {
  const h = await headers();
  if (!isSameOrigin(h)) return FORBIDDEN();

  const userId = await getActiveUserId();
  if (!userId) return UNAUTHORIZED();

  const url = new URL(request.url);
  const query = listRebuildsQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    session_id: url.searchParams.get("session_id") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Query parameters are invalid.",
        fieldErrors: Object.fromEntries(
          query.error.issues.map((i) => [
            i.path.map(String).join(".") || "_query",
            i.message,
          ]),
        ),
      },
      { status: 400 },
    );
  }

  const rows = await listRebuilds({
    userId,
    status: query.data.status,
    sessionId: query.data.session_id,
    limit: query.data.limit,
  });

  return NextResponse.json(
    { rebuilds: rows.map(toRebuildDto) },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}

/* ──────────────────────────────────────────────────────────── */
/*                              POST                             */
/* ──────────────────────────────────────────────────────────── */

export async function POST(request: Request): Promise<Response> {
  const h = await headers();
  if (!isSameOrigin(h)) return FORBIDDEN();

  const userId = await getActiveUserId();
  if (!userId) return UNAUTHORIZED();

  const limit = await rebuildWriteLimiter().check(userId);
  if (!limit.success) {
    const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many rebuild edits. Try again shortly.",
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

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

  let body: unknown;
  try {
    body = bodyText.length === 0 ? {} : JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { error: "bad_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = createRebuildBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Body is invalid.",
        fieldErrors: Object.fromEntries(
          parsed.error.issues.map((i) => [
            i.path.map(String).join(".") || "_form",
            i.message,
          ]),
        ),
      },
      { status: 400 },
    );
  }

  // Source session validation. The spec requires the session to
  // belong to the user AND be in state='complete'. Both checks
  // collapse into a single ownership-pinned `getSession`
  // followed by a state assert; we reject with 404 for "not
  // owned" (no info disclosure) and 409 for "owned but wrong
  // state".
  if (parsed.data.source_session_id) {
    const session = await getSession(parsed.data.source_session_id, userId);
    if (!session) {
      return NextResponse.json(
        {
          error: "source_session_not_found",
          message:
            "The source session doesn't exist or you don't have access to it.",
        },
        { status: 404 },
      );
    }
    if (session.state !== "complete") {
      return NextResponse.json(
        {
          error: "source_session_not_complete",
          message:
            "Rebuilds can only be started from sessions that have a complete report.",
          currentState: session.state,
        },
        { status: 409 },
      );
    }
  }

  // Source artifact validation. The artifact must belong to a
  // session the user owns. We resolve via a single join (artifact
  // → session.userId) so a cross-tenant probe reads back as the
  // same 404 we use for "not found" (no info disclosure).
  //
  // The artifact's session is NOT required to equal
  // source_session_id (those are independent backlinks; the
  // Analytics-tab launch path may pin both, while a future
  // cross-session entry point may pin only the artifact). When
  // both are pinned we still verify their consistency below.
  if (parsed.data.source_artifact_id) {
    const [artifactOwner] = await db
      .select({
        artifactId: schema.artifacts.id,
        sessionId: schema.artifacts.sessionId,
      })
      .from(schema.artifacts)
      .innerJoin(
        schema.interviewSessions,
        eq(schema.artifacts.sessionId, schema.interviewSessions.id),
      )
      .where(
        and(
          eq(schema.artifacts.id, parsed.data.source_artifact_id),
          eq(schema.interviewSessions.userId, userId),
        ),
      )
      .limit(1);

    if (!artifactOwner) {
      return NextResponse.json(
        {
          error: "source_artifact_not_found",
          message:
            "The source question doesn't exist or you don't have access to it.",
        },
        { status: 404 },
      );
    }
    if (
      parsed.data.source_session_id &&
      artifactOwner.sessionId !== parsed.data.source_session_id
    ) {
      // Both pins given but they disagree — likely a stale client
      // re-using one of them. 400 is more honest than swapping in
      // the artifact's actual session id silently.
      return NextResponse.json(
        {
          error: "source_artifact_session_mismatch",
          message:
            "The source artifact belongs to a different session than the one you provided.",
        },
        { status: 400 },
      );
    }
  }

  // Pre-selected profile item validation. The UUID must point at
  // one of the user's `projects` OR `stories` rows. We probe both
  // in parallel and accept a hit on either.
  if (parsed.data.pre_selected_profile_item_id) {
    const [projectHit, storyHit] = await Promise.all([
      db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, parsed.data.pre_selected_profile_item_id),
            eq(schema.projects.userId, userId),
          ),
        )
        .limit(1),
      db
        .select({ id: schema.stories.id })
        .from(schema.stories)
        .where(
          and(
            eq(schema.stories.id, parsed.data.pre_selected_profile_item_id),
            eq(schema.stories.userId, userId),
          ),
        )
        .limit(1),
    ]);
    if (projectHit.length === 0 && storyHit.length === 0) {
      return NextResponse.json(
        {
          error: "pre_selected_profile_item_not_found",
          message:
            "The pre-selected profile item doesn't exist or you don't have access to it.",
        },
        { status: 404 },
      );
    }
  }

  // Idempotency for the report-driven entry points: if the user
  // already has an `in_progress` rebuild for the exact same
  // (source_session_id, source_improvement_index) pair, return it
  // instead of opening a duplicate. A user double-clicking
  // "Rebuild a story for this →" inline in the report would
  // otherwise pile up empty rebuild rows pointing at the same
  // improvement — the rate limiter (240/5m) is too coarse to
  // catch that.
  //
  // We only dedupe when a source session is pinned. A standalone
  // rebuild has no equivalence key — every click is genuinely a
  // new attempt — so we let the create proceed.
  if (parsed.data.source_session_id) {
    const existing = await findInProgressRebuildForImprovement({
      userId,
      sourceSessionId: parsed.data.source_session_id,
      sourceImprovementIndex: parsed.data.source_improvement_index ?? null,
    });
    if (existing) {
      return NextResponse.json(
        { rebuild: toRebuildDto(existing) },
        {
          status: 200,
          headers: { "Cache-Control": "no-store, must-revalidate" },
        },
      );
    }
  }

  const row = await createRebuild({
    userId,
    sourceSessionId: parsed.data.source_session_id ?? null,
    sourceImprovementIndex: parsed.data.source_improvement_index ?? null,
    sourceArtifactId: parsed.data.source_artifact_id ?? null,
    preSelectedProfileItemId:
      parsed.data.pre_selected_profile_item_id ?? null,
    questionText: parsed.data.question_text,
    questionTheme: parsed.data.question_theme ?? null,
  });

  // Source taxonomy mirrors the analytics dimension in the spec:
  //   - 'report_inline'  → user clicked a per-improvement button
  //                        on the report (carries both
  //                        source_session_id AND
  //                        source_improvement_index).
  //   - 'report_bottom'  → user clicked a "Strengthen your story
  //                        bank" card (carries source_session_id
  //                        but not the per-improvement index).
  //   - 'standalone'     → no source_session_id pinned.
  // We classify here from the body shape rather than asking the
  // client to label itself — the body already tells us
  // unambiguously.
  const analyticsSource: "report_inline" | "report_bottom" | "standalone" =
    parsed.data.source_session_id
      ? parsed.data.source_improvement_index !== undefined
        ? "report_inline"
        : "report_bottom"
      : "standalone";

  trackServerEvent({
    distinctId: userId,
    event: ANALYTICS_EVENTS.rebuildStarted,
    properties: {
      source: analyticsSource,
      has_source_session: parsed.data.source_session_id !== undefined,
      has_question_theme: parsed.data.question_theme !== undefined,
    },
  });

  return NextResponse.json(
    { rebuild: toRebuildDto(row) },
    {
      status: 201,
      headers: { "Cache-Control": "no-store, must-revalidate" },
    },
  );
}
