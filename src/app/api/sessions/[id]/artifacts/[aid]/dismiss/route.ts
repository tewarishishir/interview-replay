import { NextResponse } from "next/server";

import {
  authorizeAction,
  type ActionRouteContext,
} from "@/lib/sessions/artifact-action-shared";
import { serializeArtifact } from "@/lib/sessions/artifact-serializer";
import { dismissArtifact } from "@/lib/sessions/artifacts";

/**
 * POST /api/sessions/:id/artifacts/:aid/dismiss
 *
 * Mark an AI-inferred artifact as "wasn't asked". Sets
 * `dismissed_at = now()` and leaves everything else intact, so the
 * candidate can hit Restore from the augment screen if they
 * dismiss it by mistake. The analyze pass treats dismissed rows as
 * unprompted speech (the linked answer chunk stops being associated
 * with a question).
 *
 * Idempotent: re-dismissing an already-dismissed row succeeds as a
 * no-op.
 */
export async function POST(
  _request: Request,
  context: ActionRouteContext,
): Promise<Response> {
  const result = await authorizeAction(context);
  if (!result.ok) return result.response;
  const { ctx } = result;

  const updated = await dismissArtifact({
    artifactId: ctx.artifactId,
    sessionId: ctx.sessionId,
    userId: ctx.userId,
  });

  if (!updated) {
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
