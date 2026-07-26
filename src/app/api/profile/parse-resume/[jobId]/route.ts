import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { toResumeParseJobDto } from "@/lib/profiles/dto";
import { getResumeParseJob } from "@/lib/queries/profiles";
import { resumeParsePollLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";

/**
 * `GET /api/profile/parse-resume/:jobId`
 *
 * Polling endpoint for the resume-parse worker. The frontend
 * polls every ~2s while the status is `pending` or `processing`
 * and stops as soon as it sees `completed` (with `draft`) or
 * `failed` (with `errorMessage`).
 *
 * Ownership is enforced by `getResumeParseJob` (the SELECT pins
 * `user_id` alongside `id`). Returns 404 for both "not found"
 * and "owned by someone else" so we don't leak ownership.
 */

const paramsSchema = z.object({
  jobId: z.uuid(),
});

type RouteContext = {
  params: Promise<{ jobId: string }>;
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

  const limit = await resumeParsePollLimiter().check(userId);
  if (!limit.success) {
    const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many polling requests. Try again shortly.",
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "not_found", message: "Resume parse job not found." },
      { status: 404 },
    );
  }

  const row = await getResumeParseJob(parsed.data.jobId, userId);
  if (!row) {
    return NextResponse.json(
      { error: "not_found", message: "Resume parse job not found." },
      { status: 404 },
    );
  }

  return NextResponse.json({ job: toResumeParseJobDto(row) }, { status: 200 });
}
