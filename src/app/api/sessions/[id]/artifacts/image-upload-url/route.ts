import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { getSession } from "@/lib/queries/sessions";
import { sessionReviewWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { StorageNotConfiguredError } from "@/lib/storage";
import { artifactKey, MAX_ARTIFACT_SIZE_BYTES } from "@/lib/storage/keys";
import { signFileToken } from "@/lib/storage/signed-url";

const ALLOWED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
type AllowedImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];
const allowedImageMimeSchema = z.enum(ALLOWED_IMAGE_MIMES);
const MAX_ARTIFACT_IMAGE_BYTES = MAX_ARTIFACT_SIZE_BYTES;
import { ARTIFACT_WRITE_ALLOWED_STATES } from "@/lib/sessions/artifacts";

/**
 * POST /api/sessions/:id/artifacts/image-upload-url
 *
 * Body: { content_type: AllowedImageMime, file_size_bytes: number }
 *
 * Mints an upload URL the browser can use to upload an artifact image
 * to local storage, plus a logical `image_url` the client should pass
 * back to `POST /api/sessions/:id/artifacts` once the upload completes.
 *
 * Validation we do BEFORE signing:
 *   - Same-origin / auth / rate-limit (boilerplate).
 *   - Session exists, owned by the caller, in a write-allowed state.
 *   - `content_type` is one of the four spec-mandated MIMEs.
 *   - `file_size_bytes` is below `MAX_ARTIFACT_IMAGE_BYTES` (5 MB).
 *
 * The size check here is advisory — the upload endpoint also
 * enforces a size ceiling, so even if the client lies and uploads a
 * bigger file, the server rejects it. The pre-check exists so
 * honest clients fail fast with a useful error message instead of
 * going through the upload to find out.
 */

const MAX_BODY_BYTES = 4 * 1024;

const requestBodySchema = z.object({
  content_type: allowedImageMimeSchema,
  file_size_bytes: z
    .number()
    .int()
    .positive()
    .max(MAX_ARTIFACT_IMAGE_BYTES),
});

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
        message: "Too many uploads. Try again in a minute.",
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

  let raw: unknown;
  try {
    raw = bodyText.length === 0 ? {} : JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { error: "bad_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsedBody = requestBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsedBody.error.issues) {
      const k = issue.path.map(String).join(".") || "_form";
      fieldErrors[k] ??= issue.message;
    }
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Image upload request is invalid.",
        fieldErrors,
        // Surface the constraints so the client can render a
        // helpful error without hard-coding our limits in two places.
        constraints: {
          maxBytes: MAX_ARTIFACT_IMAGE_BYTES,
          allowedMimes: ALLOWED_IMAGE_MIMES,
        },
      },
      { status: 400 },
    );
  }

  const session = await getSession(sessionId, userId);
  if (!session) {
    return NextResponse.json(
      { error: "not_found", message: "Session not found." },
      { status: 404 },
    );
  }
  if (!ARTIFACT_WRITE_ALLOWED_STATES.includes(session.state)) {
    return NextResponse.json(
      {
        error: "state_conflict",
        message:
          "Artifacts can only be added once the recording has been transcribed.",
        currentState: session.state,
      },
      { status: 409 },
    );
  }

  const ext = parsedBody.data.content_type.split("/")[1] ?? "png";
  const key = artifactKey(userId, sessionId, ext);

  let uploadUrl: string;
  let imageUrl: string;
  try {
    const token = signFileToken(key, 3600);
    uploadUrl = `/api/storage/upload?token=${token}`;
    imageUrl = key;
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
    console.error(
      `[POST /api/sessions/${sessionId}/artifacts/image-upload-url] token generation failed:`,
      err,
    );
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Could not mint upload URL. Please try again.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      url: uploadUrl,
      key,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      requiredHeaders: { "Content-Type": parsedBody.data.content_type },
      imageUrl,
      maxBytes: MAX_ARTIFACT_IMAGE_BYTES,
    },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}
