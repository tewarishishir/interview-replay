import { NextResponse } from "next/server";

import {
  authorizeAction,
  type ActionRouteContext,
} from "@/lib/sessions/artifact-action-shared";
import { serializeArtifact } from "@/lib/sessions/artifact-serializer";
import { confirmArtifact } from "@/lib/sessions/artifacts";

/**
 * POST /api/sessions/:id/artifacts/:aid/confirm
 *
 * Promote an AI-inferred artifact to "user-confirmed" by stamping
 * `user_confirmed_at = now()`. The row stays `source = 'ai_inferred'`
 * — the candidate has acknowledged the guess as correct, but the
 * audit trail still shows the AI made the original suggestion. The
 * augment screen renders confirmed-but-still-AI rows under
 * "Confirmed" alongside genuinely user-added ones.
 *
 * Idempotent: a re-confirm on an already-confirmed row succeeds
 * without changing anything (the WHERE in `confirmArtifact` falls
 * through to "row not found in eligible state"). We surface that
 * with the most-recent state of the row so the client model stays
 * accurate.
 */
export async function POST(
  _request: Request,
  context: ActionRouteContext,
): Promise<Response> {
  const result = await authorizeAction(context);
  if (!result.ok) return result.response;
  const { ctx } = result;

  if (ctx.isDismissed) {
    return NextResponse.json(
      {
        error: "state_conflict",
        message:
          "This inference was previously dismissed. Restore it before confirming.",
      },
      { status: 409 },
    );
  }

  const updated = await confirmArtifact({
    artifactId: ctx.artifactId,
    sessionId: ctx.sessionId,
    userId: ctx.userId,
  });

  if (!updated) {
    // Either the row vanished between authorize and update, OR it
    // was already confirmed. The augment UI treats both as "your
    // model is stale, refetch" — surface a 409 so the client can
    // re-pull the artifact list.
    return NextResponse.json(
      {
        error: "no_op",
        message: "Artifact was not updated. Please refresh and try again.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json(
    { artifact: serializeArtifact(updated) },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}
