import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { getActiveUserId } from "@/lib/auth/session";
import { toProfileDto } from "@/lib/profiles/dto";
import { toggleProfileExclusion } from "@/lib/profiles/persist";
import { profileExcludeBodySchema } from "@/lib/profiles/schemas";
import { profileWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";

/**
 * `PATCH /api/profile/exclude`
 *
 * Body: `{ field: "resume" | "projects" | "stories" | "target",
 *          excluded: boolean }`
 *
 * Toggles the per-section "exclude from analysis" flag, creating
 * the user_profiles row on the fly if needed (a fresh user can
 * toggle this before saving any other field).
 *
 * Echoes the new full profile so the form can keep its mirror in
 * lockstep without a follow-up GET.
 */

const MAX_BODY_BYTES = 1024;

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

  const parsed = profileExcludeBodySchema.safeParse(body);
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
    const row = await toggleProfileExclusion({
      userId,
      field: parsed.data.field,
      excluded: parsed.data.excluded,
    });
    return NextResponse.json({ profile: toProfileDto(row) }, { status: 200 });
  } catch (err) {
    console.error("[PATCH /api/profile/exclude] update failed:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Could not update exclusion." },
      { status: 500 },
    );
  }
}
