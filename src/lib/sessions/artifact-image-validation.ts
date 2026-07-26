import "server-only";

import { NextResponse } from "next/server";

import { StorageNotConfiguredError } from "@/lib/storage";
import { fileExists } from "@/lib/storage/exists";
import { MAX_ARTIFACT_SIZE_BYTES as MAX_ARTIFACT_IMAGE_BYTES } from "@/lib/storage/keys";

export function allowedImageHosts(): true {
  return true;
}

export type ImageUrlValidation =
  | { ok: true }
  | { ok: false; response: Response };

export async function validateArtifactImageUrl(args: {
  imageUrl: string;
  userId: string;
  sessionId: string;
}): Promise<ImageUrlValidation> {
  const { imageUrl, userId, sessionId } = args;

  /* 1. Key shape validation. The imageUrl IS the storage key. */
  const key = imageUrl;
  const keyPattern = /^artifacts\/([^/]+)\/([^/]+)\/[^/]+\.(png|jpg|jpeg|gif|webp)$/;
  const match = key.match(keyPattern);
  if (!match) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "invalid_image_url",
          message:
            "image_url must be a storage key we issued for this session.",
        },
        { status: 400 },
      ),
    };
  }

  /* 2. Ownership check on the embedded (userId, sessionId). */
  const keyUserId = match[1];
  const keySessionId = match[2];
  if (keyUserId !== userId.toLowerCase()) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "image_url_user_mismatch",
          message:
            "image_url belongs to a different user. Re-upload the image and try again.",
        },
        { status: 403 },
      ),
    };
  }
  if (keySessionId !== sessionId.toLowerCase()) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "image_url_session_mismatch",
          message:
            "image_url belongs to a different session. Re-upload the image inside this session.",
        },
        { status: 403 },
      ),
    };
  }

  /* 3. Existence + size. */
  let meta;
  try {
    meta = await fileExists(key);
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: err.code,
            message:
              "Image storage is not configured in this environment. " +
              "Contact the operator.",
          },
          { status: err.status },
        ),
      };
    }
    console.error("[validateArtifactImageUrl] stat failed:", err);
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "storage_unavailable",
          message: "Image storage is temporarily unavailable. Please retry.",
        },
        { status: 503 },
      ),
    };
  }

  if (!meta.exists) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "image_not_uploaded",
          message:
            "We couldn't find the uploaded image in storage. Please re-upload and try again.",
        },
        { status: 409 },
      ),
    };
  }
  if (
    typeof meta.size === "number" &&
    meta.size > MAX_ARTIFACT_IMAGE_BYTES
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "image_too_large",
          message: `Image exceeds the ${MAX_ARTIFACT_IMAGE_BYTES / (1024 * 1024)} MB limit.`,
          maxBytes: MAX_ARTIFACT_IMAGE_BYTES,
        },
        { status: 413 },
      ),
    };
  }

  return { ok: true };
}
