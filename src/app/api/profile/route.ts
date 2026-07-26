import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { getActiveUserId } from "@/lib/auth/session";
import { getProfile } from "@/lib/queries/profiles";
import { profileWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { emptyProfileDto, toProfileDto } from "@/lib/profiles/dto";
import { applyProfilePatch } from "@/lib/profiles/persist";
import { profilePatchSchema } from "@/lib/profiles/schemas";

/**
 * `GET  /api/profile` — returns the caller's profile slab. Brand-
 *                        new users get the empty-defaults DTO so
 *                        the form has a stable shape to bind to.
 *
 * `PATCH /api/profile` — partial update. Any subset of resume +
 *                        target fields. Bumps section timestamps
 *                        on the columns we actually wrote to.
 *
 * Rate-limit: profileWriteLimiter (240/5min, generous because the
 * UI auto-saves and a real first-setup session can fire many
 * partial updates in a row).
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

  const row = await getProfile(userId);
  return NextResponse.json(
    { profile: row ? toProfileDto(row) : emptyProfileDto() },
    { status: 200 },
  );
}

export async function PATCH(request: Request): Promise<Response> {
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
        message: "Too many profile updates. Try again in a moment.",
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

  const parsed = profilePatchSchema.safeParse(body);
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
    const row = await applyProfilePatch({ userId, patch: parsed.data });
    return NextResponse.json({ profile: toProfileDto(row) }, { status: 200 });
  } catch (err) {
    console.error("[PATCH /api/profile] update failed:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Could not save your profile." },
      { status: 500 },
    );
  }
}
