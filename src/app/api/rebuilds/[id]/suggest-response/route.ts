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
import type { RebuildQuestionTheme } from "@/lib/db/schema";
import { LlmNotConfiguredError } from "@/lib/llm";
import { rebuildCritiqueLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import {
  applySuggestedResponse,
  assertSuggestedResponseRateOk,
  countSuggestionsInLast24h,
  getRebuild,
  RebuildSuggestRateLimitError,
  runSuggestResponse,
  toRebuildDto,
} from "@/lib/rebuilds";

/**
 * POST /api/rebuilds/:id/suggest-response
 *
 * Generate an AI suggested STAR-format draft for the rebuild's
 * question, drawing on the candidate's profile + projects +
 * stories. The user reads it alongside their own draft to
 * validate / compare.
 *
 * Steps mirror the critique route (`./critique/route.ts`) almost
 * 1:1 — same auth, same same-origin guard, same per-user burst
 * limiter, same per-rebuild 10/24h gate (separate counter), same
 * credit infra. Differences:
 *
 *   1. Calls `runSuggestResponse` instead of `runCritique`. The
 *      runner uses the small model with a generation-authorized
 *      system prompt, then runs a verbatim guardrail asserting
 *      every `sources[].field_value` actually appears in the
 *      profile context. A trip falls back to a synthetic
 *      structural placeholder so the user always sees something.
 *
 *   2. Persists via `applySuggestedResponse`, which writes to
 *      `ai_suggested_response_json` + `ai_suggested_response_*`
 *      columns and the parallel `suggested_response_history`
 *      array. Status is NOT flipped — a suggestion is a
 *      side-channel, not a lifecycle event.
 *
 *   3. Charges the same per-call credit cost as critique
 *      (`REBUILD_CRITIQUE_CREDIT_COST = 0.20`). We share the
 *      `rebuild_critique_units` accumulator in v1; splitting
 *      buys nothing for analytics yet and the cost per Haiku
 *      call is comparable.
 *
 * On synthetic fallback (`passedGuardrails === false` from the
 * runner — schema-validation drift OR verbatim-citation
 * hallucination):
 *
 *   - Skip persistence entirely. The synthetic body is just
 *     STAR-shaped placeholders ("[fill in metric]"); persisting
 *     it would *overwrite* a previously-good cached suggestion on
 *     a regenerate, destroying the user's draft for no value.
 *     This is the load-bearing divergence from `applyCritique`,
 *     where the fallback critique still carries 5 dimensions of
 *     structural feedback the user can use.
 *
 *   - Skip the daily rate gate increment. The
 *     `suggested_response_history` array stays untouched, so a
 *     streak of guardrail trips doesn't burn the user's 10/24h
 *     budget on calls that produced no value. The per-user
 *     burst limiter (`rebuildCritiqueLimiter`, 12/5min) is the
 *     authoritative DoS guard.
 *
 *   - Skip the credit charge. The user didn't get the value of
 *     a grounded draft.
 *
 *   - Surface the synthetic body in-band as
 *     `syntheticSuggestion` so the client can render the
 *     "AI generation failed — try again" caveat without touching
 *     the cached `aiSuggestedResponse`.
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

  // Per-user burst layer. We deliberately reuse the critique
  // limiter — both surfaces are Haiku calls of comparable cost,
  // and a single user shouldn't be chaining 12 LLM calls a minute
  // across either flow.
  const burst = await rebuildCritiqueLimiter().check(userId);
  if (!burst.success) {
    const retryAfter = Math.max(1, Math.ceil((burst.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many AI generation requests in a short period. Try again shortly.",
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return NOT_FOUND();

  const rebuild = await getRebuild(parsedParams.data.id, userId);
  if (!rebuild) return NOT_FOUND();

  // Lifecycle gate. Generating a suggestion against a
  // `saved_to_bank` rebuild would diverge it from the promoted
  // story; against a `discarded` one would resurrect a soft-
  // deleted draft. Both are 409 (same posture as critique).
  if (rebuild.status === "saved_to_bank" || rebuild.status === "discarded") {
    return NextResponse.json(
      {
        error: "rebuild_wrong_state",
        message:
          "This rebuild can no longer accept a new AI draft — it has been saved to your story bank or discarded.",
        status: rebuild.status,
      },
      { status: 409 },
    );
  }

  // Per-rebuild content gate. 10/24h. Independent counter from
  // critique so a user with critique budget left can still
  // generate suggestions and vice-versa.
  try {
    assertSuggestedResponseRateOk(rebuild);
  } catch (err) {
    if (err instanceof RebuildSuggestRateLimitError) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: `You've used ${err.limit} AI drafts on this rebuild in the last 24 hours.`,
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

  // Credit preflight. Same accumulator as critique in v1 — both
  // are Haiku calls of comparable cost. We refuse before the LLM
  // round-trip when the user can't afford the rollover charge.
  let costPreview: Awaited<
    ReturnType<typeof previewRebuildCritiqueCost>
  >;
  try {
    costPreview = await previewRebuildCritiqueCost({ userId });
  } catch (err) {
    console.error("[rebuild_suggest_preflight]", err);
    return NextResponse.json(
      {
        error: "service_unavailable",
        message:
          "We couldn't check your credit balance right now. Try again in a moment.",
      },
      { status: 503 },
    );
  }
  if (!costPreview) {
    return UNAUTHORIZED();
  }
  if (!costPreview.canAffordNext) {
    return NextResponse.json(
      {
        error: "insufficient_credits",
        message:
          `You're out of credits. Each AI draft costs ${REBUILD_CRITIQUE_CREDIT_COST.toFixed(2)} credits ` +
          `— top up to keep practicing.`,
        required: costPreview.wouldChargeCredits,
        available: costPreview.currentBalance,
        perCritiqueCost: REBUILD_CRITIQUE_CREDIT_COST,
      },
      { status: 402 },
    );
  }

  // Run the suggestion. The runner does NOT throw on schema /
  // guardrail failure — it returns a synthetic fallback with
  // `passedGuardrails: false` so the user always gets something.
  let result;
  try {
    result = await runSuggestResponse({
      context: {
        userId: rebuild.userId,
        questionText: rebuild.questionText,
        // The DB column is text-typed for forward-compat. The
        // application edge writes only `RebuildQuestionTheme`
        // values (validated at PATCH time); the cast here is the
        // narrowing acknowledgement.
        questionTheme:
          (rebuild.questionTheme as RebuildQuestionTheme | null) ?? null,
      },
    });
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) {
      return NextResponse.json(
        {
          error: "llm_unavailable",
          message:
            "AI draft generation is temporarily unavailable in this environment.",
        },
        { status: 503 },
      );
    }
    throw err;
  }

  // Profile-empty short-circuit: the candidate has no resume,
  // projects, or stories — calling the LLM would produce purely
  // generic text. Return 422 so the UI can show a "fill in your
  // profile first" panel instead of a useless placeholder draft.
  // No credit charge, no persistence, no rate-gate increment.
  if (result.profileEmpty) {
    return NextResponse.json(
      {
        error: "profile_empty",
        message:
          "Your profile has no projects, stories, or resume yet. " +
          "Add some content first — InterviewReplay grounds the AI draft on your real experience.",
      },
      { status: 422 },
    );
  }

  // Guardrail trip / synthetic fallback short-circuit. Skip
  // persistence so a previously-good cached suggestion is NOT
  // overwritten with placeholder text; skip the rate-gate
  // increment so a streak of trips doesn't burn the user's
  // 10/24h budget; skip the credit charge.
  if (!result.passedGuardrails) {
    console.warn("[rebuild_suggest] guardrail tripped", {
      rebuildId: rebuild.id,
      reason: result.guardrailReason ?? "(unspecified)",
    });
    trackServerEvent({
      distinctId: userId,
      event: ANALYTICS_EVENTS.rebuildSuggestedResponseGuardrailTripped,
      properties: { reason: result.guardrailReason ?? null },
    });
    // The unmodified row is still the source of truth for the
    // client — the cached `aiSuggestedResponse` (if any) and the
    // suggestion-run counter come from the existing columns.
    return NextResponse.json(
      {
        rebuild: toRebuildDto(rebuild),
        syntheticSuggestion: result.suggestion,
        passedGuardrails: false,
        creditsCharged: 0 as const,
        balanceAfter: null,
      },
      { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
    );
  }

  // Persist the new suggestion + push the prior one onto history.
  // We only reach here when the runner returned a real, validated,
  // guardrail-passing suggestion. The persist layer uses the
  // timestamp we pass for the new entry so analytics and the
  // daily gate read a deterministic value back.
  const at = new Date();
  const applied = await applySuggestedResponse({
    rebuildId: rebuild.id,
    userId,
    suggestion: result.suggestion,
    modelVersion: result.modelVersion,
    at,
  });
  if (!applied.ok) {
    if (applied.reason === "wrong_state") {
      return NextResponse.json(
        {
          error: "rebuild_wrong_state",
          message:
            "This rebuild was saved or discarded while we were generating an AI draft.",
        },
        { status: 409 },
      );
    }
    return NOT_FOUND();
  }

  const updated = applied.row;

  // Charge the user. The route's earlier preflight makes the
  // rollover-without-balance case rare; landing in the catch
  // here means a race where the balance dropped during the LLM
  // call. We log + serve the suggestion anyway because the user
  // already saw the work happen.
  let creditsCharged: 0 | 1 = 0;
  let balanceAfter: number | null = null;
  try {
    const charge = await chargeRebuildCritique({
      userId,
      surface: { kind: "rebuild_suggest", rebuildId: rebuild.id },
    });
    creditsCharged = charge.creditsCharged;
    balanceAfter = charge.balanceAfter;
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      console.warn("[rebuild_suggest] charge race skipped", {
        rebuildId: rebuild.id,
        required: err.required,
        available: err.available,
      });
    } else {
      console.error("[rebuild_suggest_charge]", err);
    }
  }

  const dto = toRebuildDto(updated);

  trackServerEvent({
    distinctId: userId,
    event: ANALYTICS_EVENTS.rebuildSuggestedResponseRequested,
    properties: {
      suggestion_runs_last_24h: countSuggestionsInLast24h(updated, at),
      passed_guardrails: true,
      model_version: result.modelVersion,
      prompt_version: result.promptVersion,
      credits_charged: creditsCharged,
      sources_count: result.suggestion.sources.length,
      caveats_count: result.suggestion.caveats.length,
    },
  });

  return NextResponse.json(
    {
      rebuild: dto,
      syntheticSuggestion: null,
      passedGuardrails: true,
      creditsCharged,
      balanceAfter,
    },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}
