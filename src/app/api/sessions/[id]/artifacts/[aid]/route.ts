import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import {
  ACTIVE_ARTIFACT_TYPES,
  type ActiveArtifactType,
} from "@/lib/db/schema";
import { getOwnedArtifact } from "@/lib/queries/transcripts";
import { getSession } from "@/lib/queries/sessions";
import { sessionReviewWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { serializeArtifact } from "@/lib/sessions/artifact-serializer";
import { validateArtifactImageUrl } from "@/lib/sessions/artifact-image-validation";
import {
  ARTIFACT_WRITE_ALLOWED_STATES,
  deleteArtifact,
  updateArtifact,
  updateArtifactBodySchema,
} from "@/lib/sessions/artifacts";

/**
 * PATCH and DELETE handlers for `/api/sessions/:id/artifacts/:aid`.
 *
 * The two methods share roughly the same auth/origin/state shape as
 * the collection route, with one extra hop: we must also verify the
 * artifact exists and belongs to the session (which transitively
 * belongs to the user). `getOwnedArtifact` does that join in one
 * indexed lookup.
 *
 * Type guard for legacy rows: an artifact row inserted before the
 * v1 enum migration may carry a legacy type (`whiteboard_image`,
 * etc.) that the new write schema doesn't accept. We refuse to
 * mutate those — the candidate has to delete and re-create as one
 * of the active types. Read paths (the `/augment` page) silently
 * filter them out so the UI doesn't render a broken control.
 */

const MAX_BODY_BYTES = 64 * 1024;

const paramsSchema = z.object({
  id: z.string().uuid(),
  aid: z.string().uuid(),
});

type RouteContext = {
  params: Promise<{ id: string; aid: string }>;
};

interface AuthorizedContext {
  sessionId: string;
  artifactId: string;
  userId: string;
  currentType: ActiveArtifactType;
  currentSource: "user_added" | "ai_inferred";
  isDismissed: boolean;
  isConfirmed: boolean;
}

type AuthorizedResult =
  | { ok: true; ctx: AuthorizedContext }
  | { ok: false; response: Response };

/**
 * Centralized authorization. Returns either the resolved context
 * or a Response that the caller should return immediately. Used by
 * both PATCH and DELETE so the two handlers stay focused on their
 * actual work.
 */
async function authorize(
  context: RouteContext,
  h: Headers,
): Promise<AuthorizedResult> {
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
  if (
    !(ACTIVE_ARTIFACT_TYPES as readonly string[]).includes(artifact.artifactType)
  ) {
    // Legacy row from before the v1 enum migration. Refuse to mutate
    // — the candidate should delete-and-recreate as a current type.
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "legacy_type",
          message:
            "This artifact predates the current schema and can no longer be edited. " +
            "Please delete and re-create it.",
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
      currentType: artifact.artifactType as ActiveArtifactType,
      currentSource: artifact.source as "user_added" | "ai_inferred",
      isDismissed: artifact.dismissedAt !== null,
      isConfirmed: artifact.userConfirmedAt !== null,
    },
  };
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const h = await headers();
  const result = await authorize(context, h);
  if (!result.ok) return result.response;
  const { ctx } = result;

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "Artifact body is too large." },
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
      { error: "payload_too_large", message: "Artifact body is too large." },
      { status: 413 },
    );
  }

  let raw: unknown;
  try {
    raw = bodyText.length === 0 ? {} : JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { error: "bad_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsedBody = updateArtifactBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsedBody.error.issues) {
      const k = issue.path.map(String).join(".") || "_form";
      fieldErrors[k] ??= issue.message;
    }
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Artifact update body is invalid.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  // If the candidate is swapping the underlying image (image_url
  // change on a design_image), re-run the same shape/ownership/HEAD
  // gate the create route uses. Without this, an attacker could
  // PATCH the URL to point at a foreign image after the fact.
  if (
    parsedBody.data.image_url !== undefined &&
    ctx.currentType === "design_image"
  ) {
    const verdict = await validateArtifactImageUrl({
      imageUrl: parsedBody.data.image_url,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    });
    if (!verdict.ok) {
      return verdict.response;
    }
  }

  let updated;
  try {
    updated = await updateArtifact({
      artifactId: ctx.artifactId,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      body: parsedBody.data,
      currentType: ctx.currentType,
      currentSource: ctx.currentSource,
    });
  } catch (err) {
    // The helper throws when the body fields don't match the
    // artifact's type (e.g. setting `image_url` on a `code`
    // artifact). Surface as a clean 400.
    return NextResponse.json(
      {
        error: "validation_failed",
        message: err instanceof Error ? err.message : "Artifact update failed.",
      },
      { status: 400 },
    );
  }

  if (!updated) {
    // Either nothing was actually changed (empty diff after the
    // type-aware filter) or the row vanished between authorize and
    // update. Both surface as 409 — the client should refetch.
    return NextResponse.json(
      {
        error: "no_op",
        message: "Artifact was not updated. Please refresh and try again.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json(
    {
      artifact: serializeArtifact(updated),
    },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}

export async function DELETE(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const h = await headers();
  const result = await authorize(context, h);
  if (!result.ok) return result.response;
  const { ctx } = result;

  const deleted = await deleteArtifact({
    artifactId: ctx.artifactId,
    sessionId: ctx.sessionId,
    userId: ctx.userId,
  });

  if (!deleted) {
    // Idempotent delete — if the row is already gone, treat the
    // request as a success so a duplicate click from a flaky
    // network doesn't surface as an error.
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 204 });
}
