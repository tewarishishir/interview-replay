import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { getActiveUserId } from "@/lib/auth/session";
import { toProjectDto } from "@/lib/profiles/dto";
import {
  ProjectReorderMismatchError,
  reorderProjects,
} from "@/lib/profiles/persist";
import { projectReorderSchema } from "@/lib/profiles/schemas";
import { profileWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";

/**
 * `PATCH /api/projects/reorder`
 *
 * Body: `{ project_ids_in_order: ["uuid", ...] }`
 *
 * Atomically rewrites `display_order` across all of the user's
 * projects. The supplied list MUST contain every owned project
 * exactly once — a partial list (e.g. because the client raced
 * with a delete) returns 409 instead of silently dropping a row
 * from the user's view.
 */

const MAX_BODY_BYTES = 16 * 1024;

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

  const parsed = projectReorderSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join(".") || "_form";
      fieldErrors[key] ??= issue.message;
    }
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Invalid reorder payload.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  try {
    const rows = await reorderProjects({
      userId,
      projectIdsInOrder: parsed.data.project_ids_in_order,
    });
    return NextResponse.json(
      { projects: rows.map(toProjectDto) },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof ProjectReorderMismatchError) {
      return NextResponse.json(
        {
          error: err.code,
          message:
            "Your project list changed in another tab. Refresh and try again.",
        },
        { status: 409 },
      );
    }
    console.error("[PATCH /api/projects/reorder] reorder failed:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Could not reorder projects." },
      { status: 500 },
    );
  }
}
