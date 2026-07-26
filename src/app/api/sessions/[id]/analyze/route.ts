import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { analyzeRequestLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";

const MAX_REQUEST_BODY_BYTES = 1024;

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

  const now = new Date();
  const [updated] = await db
    .update(schema.interviewSessions)
    .set({ state: "analyzing", updatedAt: now })
    .where(
      and(
        eq(schema.interviewSessions.id, sessionId),
        eq(schema.interviewSessions.userId, userId),
        isNull(schema.interviewSessions.deletedAt),
      ),
    )
    .returning({ id: schema.interviewSessions.id });

  if (!updated) {
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }

  void enqueueJob("analyze-session", async () => {
    const { runAnalyzeInline } = await import(
      "@/lib/sessions/analyze-inline"
    );
    await runAnalyzeInline({
      sessionId,
      userId,
    });
  });

  return NextResponse.json(
    { sessionId },
    { status: 202 },
  );
}
