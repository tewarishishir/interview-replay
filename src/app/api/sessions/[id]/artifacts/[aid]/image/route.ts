import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { getOwnedArtifact } from "@/lib/queries/transcripts";
import { isSameOrigin } from "@/lib/same-origin";
import { StorageNotConfiguredError } from "@/lib/storage";
import { fileExists } from "@/lib/storage/exists";
import { readFileStream } from "@/lib/storage/read";

/**
 * GET /api/sessions/:id/artifacts/:aid/image
 *
 * Authenticated proxy that streams a `design_image` artifact from
 * local storage. The augment / review UI uses this as the `<img src>`
 * so the storage directory never has to be publicly accessible — the
 * spec's confidentiality posture is that artifact images live in
 * private storage and the only path to them is through an
 * authenticated, session-scoped request.
 *
 * Auth posture mirrors the rest of `/api/sessions/:id/artifacts/...`:
 *   - same-origin guard (covers same-origin GETs via `Sec-Fetch-Site`),
 *   - `getActiveUserId()` for the signed-in user,
 *   - `getOwnedArtifact()` to confirm the artifact belongs to a
 *     session owned by that user.
 *
 * No rate limiter here: this is a read-only proxy and the per-render
 * volume is bounded by how many image artifacts a session has (the
 * spec caps this at MAX_IMAGE_ARTIFACTS_PER_SESSION).
 */

const paramsSchema = z.object({
  id: z.string().uuid(),
  aid: z.string().uuid(),
});

type RouteContext = {
  params: Promise<{ id: string; aid: string }>;
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

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "not_found", message: "Artifact not found." },
      { status: 404 },
    );
  }
  const { id: sessionId, aid: artifactId } = parsedParams.data;

  const artifact = await getOwnedArtifact({
    artifactId,
    sessionId,
    userId,
  });
  if (!artifact) {
    return NextResponse.json(
      { error: "not_found", message: "Artifact not found." },
      { status: 404 },
    );
  }
  if (artifact.artifactType !== "design_image" || !artifact.imageUrl) {
    return NextResponse.json(
      {
        error: "not_an_image",
        message: "This artifact is not an image.",
      },
      { status: 404 },
    );
  }

  // The imageUrl stored on the artifact IS the storage key.
  const key = artifact.imageUrl;

  try {
    const meta = await fileExists(key);
    if (!meta.exists) {
      return NextResponse.json(
        {
          error: "image_not_found",
          message: "The image file could not be found in storage.",
        },
        { status: 404 },
      );
    }

    const stream = await readFileStream(key);
    const ext = key.split(".").pop()?.toLowerCase() ?? "png";
    const mimeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };
    const contentType = mimeMap[ext] ?? "application/octet-stream";

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
        ...(meta.size ? { "Content-Length": String(meta.size) } : {}),
      },
    });
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) {
      return NextResponse.json(
        {
          error: err.code,
          message:
            "Image storage is not configured in this environment. " +
            "Contact the operator.",
        },
        { status: err.status },
      );
    }
    console.error("[GET /artifacts/:aid/image] read failed:", err);
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message: "Image storage is temporarily unavailable. Please retry.",
      },
      { status: 503 },
    );
  }
}
