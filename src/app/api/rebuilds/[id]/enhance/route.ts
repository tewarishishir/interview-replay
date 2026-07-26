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
  assertCritiqueRateOk,
  EnhanceValidationError,
  getRebuild,
  patchRebuild,
  RebuildCritiqueRateLimitError,
  runEnhance,
  toRebuildDto,
} from "@/lib/rebuilds";

/**
 * POST /api/rebuilds/:id/enhance
 *
 * Rewrite the candidate's STAR draft by applying the suggestions
 * from the rebuild's most recent critique. Steps mirror the
 * critique route (`./critique/route.ts`) almost exactly:
 *
 *   1. Same-origin + active user — same hard gate as critique.
 *   2. Per-user burst limiter (`rebuildCritiqueLimiter`) — same
 *      cross-rebuild churn guard.
 *   3. Load + ownership-check the rebuild row.
 *   4. Status gate: only `critiqued` rebuilds can be enhanced
 *      (enhance without an existing critique makes no sense).
 *   5. Per-rebuild 10/24h content gate (`assertCritiqueRateOk`)
 *      — reuses the critique history counter so critiques and
 *      enhances share the same combined daily budget.
 *   6. Credit preflight (`previewRebuildCritiqueCost`) — same
 *      0.20-credits-per-call cost as critique.
 *   7. `runEnhance` — calls the small model with the draft + critique
 *      and returns rewritten STAR fields.
 *   8. `patchRebuild` — persists the enhanced draft fields.
 *   9. `chargeRebuildCritique` — deducts credits via the shared
 *      `rebuild_critique_units` accumulator.
 *  10. Fire `rebuild_enhance_applied` analytics event.
 *
 * Error handling diverges from the critique route in one place:
 * enhance has no guardrail fallback path. If `runEnhance` can't
 * produce a valid enhanced draft (schema-validation failure after
 * one retry) it throws `EnhanceValidationError` → 502 the user
 * can retry. Serving the user a meaningless placeholder as an
 * "applied" draft is worse UX than "something went wrong, try
 * again."
 *
 * Credit charging follows the same conventions as critique (see
 * that route for the detailed rationale): pre-LLM 402 on
 * out-of-credits, post-persist charge regardless of guardrail
 * outcomes (not applicable here), race-condition swallowed and
 * logged if the charge fails.
 */

const paramsSchema = z.object({ id: z.uuid() });
type RouteContext = { params: Promise<{ id: string }> };

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
const NOT_FOUND = (): Response =>
  NextResponse.json(
    { error: "not_found", message: "Rebuild not found." },
    { status: 404 },
  );

export async function POST(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const h = await headers();
  if (!isSameOrigin(h)) return FORBIDDEN();

  const userId = await getActiveUserId();
  if (!userId) return UNAUTHORIZED();

  // Per-user burst layer — same limiter as critique.
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

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return NOT_FOUND();

  const rebuild = await getRebuild(parsedParams.data.id, userId);
  if (!rebuild) return NOT_FOUND();

  // Enhance is only meaningful after a critique has been run.
  // Rebuilds in other states (in_progress, saved_to_bank,
  // discarded) all map to 409.
  if (rebuild.status !== "critiqued") {
    if (rebuild.status === "saved_to_bank" || rebuild.status === "discarded") {
      return NextResponse.json(
        {
          error: "rebuild_wrong_state",
          message:
            "This rebuild can no longer be enhanced — it has been saved to your story bank or discarded.",
          status: rebuild.status,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        error: "rebuild_wrong_state",
        message:
          "Run a critique on your draft first before applying suggestions.",
        status: rebuild.status,
      },
      { status: 409 },
    );
  }

  // Sanity-check: the critique payload must be present. This
  // should always hold for a `critiqued` rebuild, but an edge-case
  // where `ai_critique_json` is null despite the status would
  // produce a meaningless enhance result.
  if (!rebuild.aiCritiqueJson) {
    return NextResponse.json(
      {
        error: "rebuild_wrong_state",
        message: "No critique found. Run a critique first.",
      },
      { status: 409 },
    );
  }

  // Per-rebuild 10/24h gate. Shared with the critique counter so
  // critiques + enhances together draw from one daily budget.
  try {
    assertCritiqueRateOk(rebuild);
  } catch (err) {
    if (err instanceof RebuildCritiqueRateLimitError) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: `You've reached the limit of ${err.limit} AI operations on this rebuild in the last 24 hours.`,
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

  // Run the LLM enhancement. Unlike runCritique, there is no
  // fallback path: if the model can't produce a valid rewrite, we
  // return 502 rather than serving a meaningless placeholder as
  // "applied suggestions".
  let result;
  try {
    result = await runEnhance({ rebuild });
  } catch (err) {
    if (err instanceof EnhanceValidationError) {
      console.warn("[rebuild_enhance] validation failed", {
        rebuildId: rebuild.id,
        rawLength: err.raw.length,
      });
      return NextResponse.json(
        {
          error: "enhance_failed",
          message:
            "We couldn't rewrite your draft this time. Try again — this is usually a transient LLM issue.",
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

  // Persist the enhanced draft fields.
  const { enhanced } = result;
  const patched = await patchRebuild({
    rebuildId: rebuild.id,
    userId,
    patch: {
      situation: enhanced.situation,
      task: enhanced.task,
      action: enhanced.action,
      result: enhanced.result,
      what_i_would_change: enhanced.what_i_would_change ?? null,
    },
  });

  if (!patched.ok) {
    if (patched.reason === "wrong_state") {
      return NextResponse.json(
        {
          error: "rebuild_wrong_state",
          message:
            "This rebuild was saved or discarded while we were rewriting its draft.",
        },
        { status: 409 },
      );
    }
    return NOT_FOUND();
  }

  const updated = patched.row;

  const dto = toRebuildDto(updated);

  trackServerEvent({
    distinctId: userId,
    event: ANALYTICS_EVENTS.rebuildEnhanceApplied,
    properties: {
      model_version: result.modelVersion,
      prompt_version: result.promptVersion,
    },
  });

  return NextResponse.json(
    { rebuild: dto },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}
