import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { getActiveUserId } from "@/lib/auth/session";
import { LlmNotConfiguredError } from "@/lib/llm";
import { rebuildCritiqueLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import {
  assertStoryCritiqueRateOk,
  runStoryCritique,
  StoryCritiquePreflightError,
  StoryCritiqueRateLimitError,
} from "@/lib/stories";

/**
 * POST /api/stories/critique
 *
 * Stateless story-bank critique. Accepts a raw STAR draft (title +
 * situation/task/action/result/whatILearned), runs it through the
 * same Haiku critique pipeline as the rebuild surface, and returns
 * a `CritiqueResponse` without persisting anything to the database.
 *
 * ## Why stateless?
 *
 * The rebuild critique is attached to a rebuild row so the user can
 * come back and see their prior critique. The story-bank critique is
 * designed for an in-progress draft that may not have been saved yet
 * — the user can critique before committing, then edit and save. The
 * canonical home for a persisted critique is the rebuild flow; the
 * story-bank critique is "quick feedback while I'm writing".
 *
 * ## Auth + rate limiting
 *
 * 1. Same-origin + active user (hard gate; no guest access).
 * 2. Per-user burst limiter (`rebuildCritiqueLimiter`, 12/5min) —
 *    shared with the rebuild and story-suggest surfaces so a
 *    multi-tab burst across all surfaces is still bounded.
 * 3. Per-user 10/24h content gate (`assertStoryCritiqueRateOk`) —
 *    separate from the per-rebuild critique cap so burning through
 *    story critiques doesn't block rebuild critiques and vice-versa.
 *
 * ## Credits
 *
 * Same 0.20-credit cost as every other Haiku call. Deducted from the
 * shared `rebuild_critique_units` accumulator; the audit row uses
 * event_type `story_critique.unit_charged` for attribution. The
 * per-user 10/24h gate reads those audit rows, so the count stays
 * consistent with what was billed.
 *
 * ## Response shape
 *
 * `{ critique, passedGuardrails, guardrailTripCount }`
 *
 * `critique` is the same `CritiqueResponse` shape as the rebuild
 * critique route — the existing `CritiqueView` component works
 * unchanged.
 */

const MAX_BODY_BYTES = 32 * 1024;

const bodySchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title is required.")
    .max(200, "Title must be 200 characters or fewer."),
  situation: z.string().max(2000).default(""),
  task: z.string().max(2000).default(""),
  action: z.string().max(2000).default(""),
  result: z.string().max(2000).default(""),
  whatILearned: z.string().max(2000).default(""),
});

const FORBIDDEN = (): Response =>
  NextResponse.json(
    { error: "forbidden", message: "Cross-origin request rejected." },
    { status: 403 },
  );
const UNAUTHORIZED = (): Response =>
  NextResponse.json(
    { error: "unauthorized", message: "You must be signed in." },
    { status: 401 },
  );

export async function POST(request: Request): Promise<Response> {
  const h = await headers();
  if (!isSameOrigin(h)) return FORBIDDEN();

  const userId = await getActiveUserId();
  if (!userId) return UNAUTHORIZED();

  // Per-user burst layer — shared with rebuild + story-suggest so
  // a multi-tab burst across all AI surfaces stays bounded.
  const burst = await rebuildCritiqueLimiter().check(userId);
  if (!burst.success) {
    const retryAfter = Math.max(1, Math.ceil((burst.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message:
          "Too many critique requests in a short period. Try again shortly.",
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  // Body parse with a hard byte cap.
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "Request body too large." },
      { status: 413 },
    );
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }
  const parsedBody = bodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        message: "Request body is invalid.",
        issues: parsedBody.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }
  const draft = parsedBody.data;

  // Per-user 10/24h content gate — independent from the per-rebuild
  // critique cap so the two surfaces don't share budget.
  try {
    await assertStoryCritiqueRateOk(userId);
  } catch (err) {
    if (err instanceof StoryCritiqueRateLimitError) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: `You've used ${err.limit} story critiques in the last 24 hours.`,
          retryAfter: err.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(err.retryAfterSeconds) },
        },
      );
    }
    throw err;
  }

  // Run the critique.
  let result;
  try {
    result = await runStoryCritique({ userId, draft });
  } catch (err) {
    if (err instanceof StoryCritiquePreflightError) {
      return NextResponse.json(
        {
          error: "draft_incomplete",
          message:
            "Tell us your situation, action, and result before we can critique your story.",
          missing: err.missing,
        },
        { status: 400 },
      );
    }
    if (err instanceof LlmNotConfiguredError) {
      return NextResponse.json(
        {
          error: "llm_unavailable",
          message: "Critique is temporarily unavailable in this environment.",
        },
        { status: 503 },
      );
    }
    throw err;
  }

  // Guardrail trips — one log event per failure, mirroring the
  // rebuild critique route's pattern. The credit charge and
  // analytics event still fire — we persisted a fallback critique
  // the user can act on, and we paid for the LLM call.
  if (!result.passedGuardrails) {
    for (const failure of result.guardrailFailures) {
      console.warn(`[story_critique] guardrail tripped: ${failure.event}`, {
        reason: failure.reason,
      });
    }
  }

  trackServerEvent({
    distinctId: userId,
    event: ANALYTICS_EVENTS.storyCritiqueRequested,
    properties: {
      passed_guardrails: result.passedGuardrails,
      guardrail_trip_count: result.guardrailFailures.length,
      model_version: result.modelVersion,
      prompt_version: result.promptVersion,
    },
  });

  return NextResponse.json(
    {
      critique: result.critique,
      passedGuardrails: result.passedGuardrails,
      guardrailTripCount: result.guardrailFailures.length,
    },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}
