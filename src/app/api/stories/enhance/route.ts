import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { getActiveUserId } from "@/lib/auth/session";
import {
  chargeRebuildCritique,
  InsufficientCreditsError,
  previewRebuildCritiqueCost,
  REBUILD_CRITIQUE_CREDIT_COST,
} from "@/lib/credits";
import { LlmNotConfiguredError } from "@/lib/llm";
import { rebuildCritiqueLimiter } from "@/lib/rate-limit";
import { critiqueResponseSchema } from "@/lib/rebuilds/schemas";
import { isSameOrigin } from "@/lib/same-origin";
import {
  assertStoryCritiqueRateOk,
  StoryCritiqueRateLimitError,
  runStoryEnhance,
  StoryEnhanceValidationError,
} from "@/lib/stories";

/**
 * POST /api/stories/enhance
 *
 * Stateless story-bank "Apply suggestions" endpoint. Accepts a raw
 * STAR draft (title + situation/task/action/result/whatILearned) and
 * the `CritiqueResponse` produced by `POST /api/stories/critique`,
 * rewrites the STAR fields by applying the critique suggestions, and
 * returns the rewritten fields without persisting anything.
 *
 * Mirrors `POST /api/rebuilds/:id/enhance` but:
 *   - No rebuild row is loaded — the draft fields come from the body.
 *   - No `patchRebuild` persistence step — the client overwrites its
 *     own form textareas with the returned enhanced fields.
 *   - Uses the story AI shared 10/24h rate gate
 *     (`assertStoryCritiqueRateOk`), which counts critique + enhance
 *     ops together, so a critique→apply cycle costs 2 of 10.
 *
 * ## Error handling
 *
 * Like the rebuild enhance, there is no fallback path: if the LLM
 * can't produce a valid rewrite after one retry we return 502. A
 * placeholder "enhanced" draft would be misleading — the user
 * pressed "Apply" expecting their specific critique suggestions
 * applied.
 */

const MAX_BODY_BYTES = 64 * 1024;

const bodySchema = z.object({
  title: z.string().max(200).default(""),
  situation: z.string().max(2000).default(""),
  task: z.string().max(2000).default(""),
  action: z.string().max(2000).default(""),
  result: z.string().max(2000).default(""),
  whatILearned: z.string().max(2000).default(""),
  critique: critiqueResponseSchema,
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

  // Per-user burst layer — shared with all other Haiku surfaces.
  const burst = await rebuildCritiqueLimiter().check(userId);
  if (!burst.success) {
    const retryAfter = Math.max(1, Math.ceil((burst.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many requests in a short period. Try again shortly.",
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  // Body parse with a hard byte cap. The body includes the full
  // CritiqueResponse so the limit is larger than the critique route.
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
  const { critique, ...draftFields } = parsedBody.data;

  // Per-user 10/24h content gate — counts critique + enhance ops
  // together so the two can't exceed the combined budget.
  try {
    await assertStoryCritiqueRateOk(userId);
  } catch (err) {
    if (err instanceof StoryCritiqueRateLimitError) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: `You've reached the limit of ${err.limit} story AI operations in the last 24 hours.`,
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

  // Credit preflight — same logic as critique route.
  let costPreview: Awaited<ReturnType<typeof previewRebuildCritiqueCost>>;
  try {
    costPreview = await previewRebuildCritiqueCost({ userId });
  } catch (err) {
    console.error("[story_enhance_preflight]", err);
    return NextResponse.json(
      {
        error: "service_unavailable",
        message:
          "We couldn't check your credit balance right now. Try again in a moment.",
      },
      { status: 503 },
    );
  }
  if (!costPreview) return UNAUTHORIZED();
  if (!costPreview.canAffordNext) {
    return NextResponse.json(
      {
        error: "insufficient_credits",
        message:
          `You're out of credits. Applying suggestions costs ${REBUILD_CRITIQUE_CREDIT_COST.toFixed(2)} credits ` +
          `— top up to continue.`,
        required: costPreview.wouldChargeCredits,
        available: costPreview.currentBalance,
        perCritiqueCost: REBUILD_CRITIQUE_CREDIT_COST,
      },
      { status: 402 },
    );
  }

  // Run the LLM enhancement. No fallback: if the model can't
  // produce a valid rewrite, return 502 the user can retry.
  let result;
  try {
    result = await runStoryEnhance({ draft: draftFields, critique });
  } catch (err) {
    if (err instanceof StoryEnhanceValidationError) {
      console.warn("[story_enhance] validation failed", { rawLength: err.raw.length });
      return NextResponse.json(
        {
          error: "enhance_failed",
          message:
            "We couldn't rewrite your draft this time. Try again — this is usually a transient issue.",
        },
        { status: 502 },
      );
    }
    if (err instanceof LlmNotConfiguredError) {
      return NextResponse.json(
        {
          error: "llm_unavailable",
          message:
            "Apply suggestions is temporarily unavailable in this environment.",
        },
        { status: 503 },
      );
    }
    throw err;
  }

  // Charge the user after a successful LLM call.
  let creditsCharged: 0 | 1 = 0;
  let balanceAfter: number | null = null;
  try {
    const charge = await chargeRebuildCritique({
      userId,
      surface: { kind: "story_enhance" },
    });
    creditsCharged = charge.creditsCharged;
    balanceAfter = charge.balanceAfter;
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      console.warn("[story_enhance] charge race skipped", {
        required: err.required,
        available: err.available,
      });
    } else {
      console.error("[story_enhance_charge]", err);
    }
  }

  trackServerEvent({
    distinctId: userId,
    event: ANALYTICS_EVENTS.storyEnhanceApplied,
    properties: {
      credits_charged: creditsCharged,
      model_version: result.modelVersion,
      prompt_version: result.promptVersion,
    },
  });

  return NextResponse.json(
    {
      enhanced: {
        situation: result.enhanced.situation,
        task: result.enhanced.task,
        action: result.enhanced.action,
        result: result.enhanced.result,
        whatILearned: result.enhanced.what_i_learned ?? "",
      },
      creditsCharged,
      balanceAfter,
    },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}
