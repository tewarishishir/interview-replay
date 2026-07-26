import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { getActiveUserId } from "@/lib/auth/session";
import { PROFILE_LIMITS } from "@/lib/profiles/constants";
import { toProjectDto } from "@/lib/profiles/dto";
import {
  createProject,
  ProjectsLimitExceededError,
} from "@/lib/profiles/persist";
import { projectCreateSchema } from "@/lib/profiles/schemas";
import { listProjects } from "@/lib/queries/profiles";
import { profileWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";

/**
 * `GET  /api/projects` — list owned projects in display order.
 * `POST /api/projects` — create a new project. 409 when the
 *                        per-user cap (5) is reached so the form
 *                        can render an explanatory error.
 */

const MAX_BODY_BYTES = 32 * 1024;

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

  const rows = await listProjects(userId);
  return NextResponse.json(
    {
      projects: rows.map(toProjectDto),
      limits: {
        max: PROFILE_LIMITS.projectsMax,
        recommendedMin: PROFILE_LIMITS.projectsRecommendedMin,
      },
    },
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

  const parsed = projectCreateSchema.safeParse(body);
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
    const row = await createProject({
      userId,
      data: parsed.data,
      limit: PROFILE_LIMITS.projectsMax,
    });
    return NextResponse.json({ project: toProjectDto(row) }, { status: 201 });
  } catch (err) {
    if (err instanceof ProjectsLimitExceededError) {
      return NextResponse.json(
        {
          error: err.code,
          message: `You can keep up to ${err.limit} projects. Delete one to add another.`,
        },
        { status: 409 },
      );
    }
    console.error("[POST /api/projects] create failed:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Could not create project." },
      { status: 500 },
    );
  }
}
