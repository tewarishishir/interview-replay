import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { getActiveUserId } from "@/lib/auth/session";
import { PROFILE_LIMITS } from "@/lib/profiles/constants";
import { toStoryDto } from "@/lib/profiles/dto";
import { createStory, StoriesLimitExceededError } from "@/lib/profiles/persist";
import { storyCreateSchema } from "@/lib/profiles/schemas";
import { listStories } from "@/lib/queries/profiles";
import { profileWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";

/**
 * `GET  /api/stories` — list owned stories. The UI groups them by
 *                        theme client-side using the themes module.
 * `POST /api/stories` — create a story. The route does not enforce
 *                        a per-theme uniqueness check; the spec
 *                        renders one card per theme by default but
 *                        the data model accepts many.
 */

const MAX_BODY_BYTES = 64 * 1024;

export async function GET(): Promise<Response> {
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

  const rows = await listStories(userId);
  return NextResponse.json(
    { stories: rows.map(toStoryDto) },
    { status: 200 },
  );
}

export async function POST(request: Request): Promise<Response> {
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

  const limit = await profileWriteLimiter().check(userId);
  if (!limit.success) {
    const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many profile updates. Try again shortly.",
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

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

  let body: unknown;
  try {
    body = bodyText.length === 0 ? {} : JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { error: "bad_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = storyCreateSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join(".") || "_form";
      fieldErrors[key] ??= issue.message;
    }
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "One or more fields are invalid.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  try {
    const row = await createStory({
      userId,
      data: parsed.data,
      limit: PROFILE_LIMITS.storiesMax,
    });
    return NextResponse.json({ story: toStoryDto(row) }, { status: 201 });
  } catch (err) {
    if (err instanceof StoriesLimitExceededError) {
      return NextResponse.json(
        {
          error: err.code,
          message: `You can keep up to ${err.limit} stories. Delete one to add another.`,
        },
        { status: 409 },
      );
    }
    console.error("[POST /api/stories] create failed:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Could not create story." },
      { status: 500 },
    );
  }
}
