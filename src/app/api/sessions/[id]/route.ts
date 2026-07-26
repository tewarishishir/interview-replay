import { and, eq, ne } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { getSession } from "@/lib/queries/sessions";
import { sessionDeleteLimiter, sessionPollLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";

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

  const row = await getSession(sessionId, userId);
  if (!row) {
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }

  if (row.state === "deleted") {
    return NextResponse.json(
      { ok: true, alreadyDeleted: true },
      { status: 200 },
    );
  }

  const now = new Date();
  const [updated] = await db
    .update(schema.interviewSessions)
    .set({ state: "deleted", deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.interviewSessions.id, sessionId),
        eq(schema.interviewSessions.userId, userId),
        ne(schema.interviewSessions.state, "deleted"),
      ),
    )
    .returning({ id: schema.interviewSessions.id });

  return NextResponse.json(
    { ok: true, alreadyDeleted: !updated },
    { status: 200 },
  );
}
