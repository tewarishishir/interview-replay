import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { getSession } from "@/lib/queries/sessions";
import { sessionReviewWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { serializeArtifact } from "@/lib/sessions/artifact-serializer";
import { validateArtifactImageUrl } from "@/lib/sessions/artifact-image-validation";
import {
  ARTIFACT_WRITE_ALLOWED_STATES,
  createArtifact,
  createArtifactBodySchema,
} from "@/lib/sessions/artifacts";

/**
 * POST /api/sessions/:id/artifacts
 *
 * Body shape (from `createArtifactBodySchema`):
 *   { artifact_type, content?, image_url? }
 *
 * Type-specific validation rules live in the schema itself (see
 * `lib/sessions/artifacts.ts`):
 *   - `design_image` MUST carry `image_url` and MUST NOT carry
 *     `content`.
 *   - All other types MUST carry non-empty `content` and MUST NOT
 *     carry `image_url`.
 *
 * State guard: review | analyzing | complete. The candidate may keep
 * augmenting context after analysis kicks off; the report itself
 * doesn't move backward in time, but more context is always fine.
 */

const MAX_BODY_BYTES = 64 * 1024;

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

  const rl = sessionReviewWriteLimiter();
  const limit = await rl.check(userId);
  if (!limit.success) {
    return NextResponse.json(
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

  const parsedBody = createArtifactBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsedBody.error.issues) {
      const k = issue.path.map(String).join(".") || "_form";
      fieldErrors[k] ??= issue.message;
    }
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Artifact body is invalid.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  const row = await getSession(sessionId, userId);
  if (!row) {
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }

  if (!ARTIFACT_WRITE_ALLOWED_STATES.includes(row.state)) {
    return NextResponse.json(
      {
        error: "state_conflict",
        message:
          "Artifacts can only be added once the recording has been transcribed.",
        currentState: row.state,
      },
      { status: 409 },
    );
  }

  // For `design_image` artifacts, the schema only ensures `image_url`
  // is a string up to 2 KB. We must additionally confirm the URL
  // points at an object WE minted (right user, right session) and
  // that the actual stored size respects the 5 MB ceiling — the
  // upload token doesn't enforce Content-Length.
  // The Zod superRefine guarantees `image_url` is present here, but
  // its inferred type is still `string | undefined` (refines don't
  // narrow); the `!` is correct.
  if (parsedBody.data.artifact_type === "design_image") {
    const verdict = await validateArtifactImageUrl({
      imageUrl: parsedBody.data.image_url!,
      userId,
      sessionId,
    });
    if (!verdict.ok) {
      return verdict.response;
    }
  }

  const created = await createArtifact({
    sessionId,
    userId,
    body: parsedBody.data,
  });

  return NextResponse.json(
    {
      artifact: serializeArtifact(created),
    },
    {
      status: 201,
      headers: { "Cache-Control": "no-store, must-revalidate" },
    },
  );
}
