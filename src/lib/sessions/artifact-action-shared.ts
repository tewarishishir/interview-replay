import "server-only";

import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { getOwnedArtifact } from "@/lib/queries/transcripts";
import { getSession } from "@/lib/queries/sessions";
import { sessionReviewWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { ARTIFACT_WRITE_ALLOWED_STATES } from "@/lib/sessions/artifacts";

/**
 * Shared scaffolding for the AI-inferred artifact action routes
 * (confirm / dismiss / restore). Each action is a POST on
 * `/api/sessions/:id/artifacts/:aid/<action>` and shares the same
 * auth + ownership + state-guard requirements as the artifact PATCH
 * route — only the persistent side-effect differs.
 *
 * Pulled out so the three handlers stay tiny:
 *   1. authorize — same shape as the PATCH route.
 *   2. delegate to the action helper.
 *   3. return the serialized row (or a clean error).
 */

const paramsSchema = z.object({
  id: z.string().uuid(),
  aid: z.string().uuid(),
});

export type ActionRouteContext = {
  params: Promise<{ id: string; aid: string }>;
};

export interface ActionAuthorizedContext {
  sessionId: string;
  artifactId: string;
  userId: string;
  source: "user_added" | "ai_inferred";
  isDismissed: boolean;
  isConfirmed: boolean;
}

export type ActionAuthorizedResult =
  | { ok: true; ctx: ActionAuthorizedContext }
  | { ok: false; response: Response };

/**
 * The action routes ONLY make sense for AI-inferred rows. We surface
 * a 409 (rather than 404) when the row is found but isn't an
 * AI-inferred one, so the client gets a hint that it stuck a
 * confirm/dismiss action onto the wrong artifact.
 */
export async function authorizeAction(
  context: ActionRouteContext,
): Promise<ActionAuthorizedResult> {
  const h = await headers();
  if (!isSameOrigin(h)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "forbidden", message: "Cross-origin request rejected." },
        { status: 403 },
      ),
    };
  }

  const userId = await getActiveUserId();
  if (!userId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "unauthorized", message: "You must be signed in." },
        { status: 401 },
      ),
    };
  }

  const rl = sessionReviewWriteLimiter();
  const limit = await rl.check(userId);
  if (!limit.success) {
    return {
      ok: false,
      response: NextResponse.json(
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
      ),
    };
  }

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "not_found", message: "Artifact not found." },
        { status: 404 },
      ),
    };
  }
  const { id: sessionId, aid: artifactId } = parsedParams.data;

  const session = await getSession(sessionId, userId);
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "not_found", message: "Session not found." },
        { status: 404 },
      ),
    };
  }
  if (!ARTIFACT_WRITE_ALLOWED_STATES.includes(session.state)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "state_conflict",
          message:
            "Artifacts can only be modified once the recording has been transcribed.",
          currentState: session.state,
        },
        { status: 409 },
      ),
    };
  }

  const artifact = await getOwnedArtifact({
    artifactId,
    sessionId,
    userId,
  });
  if (!artifact) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "not_found", message: "Artifact not found." },
        { status: 404 },
      ),
    };
  }
  if (artifact.source !== "ai_inferred") {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "not_ai_inferred",
          message:
            "This action only applies to AI-inferred artifacts. " +
            "User-added artifacts use PATCH/DELETE.",
        },
        { status: 409 },
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      sessionId,
      artifactId,
      userId,
      source: artifact.source,
      isDismissed: artifact.dismissedAt !== null,
      isConfirmed: artifact.userConfirmedAt !== null,
    },
  };
}
