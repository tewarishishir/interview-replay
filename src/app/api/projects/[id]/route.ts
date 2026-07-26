import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { toProjectDto } from "@/lib/profiles/dto";
import { deleteProject, updateProject } from "@/lib/profiles/persist";
import { projectPatchSchema } from "@/lib/profiles/schemas";
import { profileWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";

/**
 * `PATCH  /api/projects/:id` — partial update.
 * `DELETE /api/projects/:id` — remove the row.
 *
 * Both routes return 404 for "not found" AND "owned by someone
 * else" so we don't leak ownership.
 */

const MAX_BODY_BYTES = 32 * 1024;

const paramsSchema = z.object({
  id: z.uuid(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(
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

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    return NextResponse.json(
      { error: "not_found", message: "Project not found." },
      { status: 404 },
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

  const parsed = projectPatchSchema.safeParse(body);
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
    const row = await updateProject({
      projectId: params.data.id,
      userId,
      patch: parsed.data,
    });
    if (!row) {
      return NextResponse.json(
        { error: "not_found", message: "Project not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ project: toProjectDto(row) }, { status: 200 });
  } catch (err) {
    console.error("[PATCH /api/projects/:id] update failed:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Could not update project." },
      { status: 500 },
    );
  }
}

export async function DELETE(
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

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    return NextResponse.json(
      { error: "not_found", message: "Project not found." },
      { status: 404 },
    );
  }

  try {
    const ok = await deleteProject({ projectId: params.data.id, userId });
    if (!ok) {
      return NextResponse.json(
        { error: "not_found", message: "Project not found." },
        { status: 404 },
      );
    }
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error("[DELETE /api/projects/:id] delete failed:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Could not delete project." },
      { status: 500 },
    );
  }
}
