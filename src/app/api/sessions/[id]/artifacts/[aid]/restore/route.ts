import { NextResponse } from "next/server";

import {
  authorizeAction,
  type ActionRouteContext,
} from "@/lib/sessions/artifact-action-shared";
import { serializeArtifact } from "@/lib/sessions/artifact-serializer";
import { restoreArtifact } from "@/lib/sessions/artifacts";

/**
 * POST /api/sessions/:id/artifacts/:aid/restore
 *
 * Reverses a previous dismiss on an AI-inferred row. Clears
 * `dismissed_at` so the row reappears under "Suggested by AI" on
 * the augment screen. Confirm-state is preserved — restoring
 * doesn't auto-confirm, just un-dismisses.
 */
export async function POST(
  _request: Request,
  context: ActionRouteContext,
): Promise<Response> {
  const result = await authorizeAction(context);
  if (!result.ok) return result.response;
  const { ctx } = result;

  const updated = await restoreArtifact({
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
