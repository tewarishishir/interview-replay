import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { getActiveUserId } from "@/lib/auth/session";
import { rebuildQuestionThemeSchema } from "@/lib/db/schema";
import { LlmNotConfiguredError } from "@/lib/llm";
import { rebuildCritiqueLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { runSuggestResponse, suggestedResponseSchema } from "@/lib/rebuilds";
import {
  applyStorySuggestedResponse,
  assertStorySuggestRateOk,
  countStorySuggestionsInLast24h,
  getStoryForUser,
  StorySuggestRateLimitError,
} from "@/lib/stories";

/**
 * POST /api/stories/:id/suggest-response
 *
 * Bank-surface counterpart to
 * `POST /api/rebuilds/:id/suggest-response`. Generates an AI
 * STAR-format draft for a saved story (rebuild-derived OR
 * hand-authored) using the story's title as the implicit
 * interview question and the story's theme as the framing.
 *
 * The auth + same-origin + burst-limiter posture matches the
 * rebuild route 1:1. The differences:
 *
 *   1. Operates on a `stories` row, not a `story_rebuilds` row.
 *      Hand-authored stories have no rebuild backing them —
 *      this is the path that makes "View AI suggested response"
 *      available on every bank card.
 *
 *   2. Per-story 10/24h gate via `assertStorySuggestRateOk`.
 *      Independent counter from the rebuild-side gate.
 *
 *   3. Persists onto `stories.aiSuggestedResponseJson` (and the
 *      parallel `suggested_response_history` array) instead of
 *      the rebuild row. The bank card UI prefers the story-side
 *      value when present, falling back to the rebuild side.
 *
 * Credit accumulator: shares `rebuild_critique_units` with the
 * rebuild surface in v1 — both are Haiku calls of comparable
 * cost. Splitting the accumulator buys nothing for analytics
 * yet.
 *
 * On synthetic fallback (`passedGuardrails === false`):
 *
 *   - Skip persistence (don't overwrite a previously-good
 *     cached suggestion with placeholders).
 *   - Skip the rate-gate increment.
 *   - Skip the credit charge.
 *   - Surface the synthetic body via `syntheticSuggestion` so
 *     the client can render the "try again" caveat without
 *     touching the row.
 *
 * Same load-bearing divergence from the critique route's
 * fallback persistence — see the rebuild-suggest route for the
 * full reasoning.
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
    { error: "not_found", message: "Story not found." },
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

  // Per-user burst layer. Same limiter as the rebuild surface so
  // a single user can't chain Haiku calls across both surfaces
  // faster than the limiter allows.
  const burst = await rebuildCritiqueLimiter().check(userId);
  if (!burst.success) {
    const retryAfter = Math.max(1, Math.ceil((burst.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message:
          "Too many AI generation requests in a short period. Try again shortly.",
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return NOT_FOUND();

  const story = await getStoryForUser(parsedParams.data.id, userId);
  if (!story) return NOT_FOUND();

  // The story title is the question we ground the LLM on. An
  // empty title is impossible (NOT NULL + non-empty CHECK at the
  // schema layer + zod validation on the create route), but
  // we defensively refuse rather than send an empty prompt to
  // the model.
  if (!story.title || story.title.trim().length === 0) {
    return NextResponse.json(
      {
        error: "story_incomplete",
        message:
          "Add a title to this story before generating an AI draft — InterviewReplay uses it as the implicit question.",
      },
      { status: 400 },
    );
  }

  // Validate the theme up front. `stories.theme` and the rebuild
  // surface's `RebuildQuestionTheme` are pinned to the same
  // enum values today, but they're maintained as two
  // separately-defined Postgres enums; an unsynced future
  // migration would let a value into `stories.theme` that
  // `rebuildQuestionThemeSchema` rejects. Catching that drift
  // here surfaces a clean 500 with a logged warning instead
  // of burning a Haiku call on a prompt the runner can't ground.
  const themeParse = rebuildQuestionThemeSchema.safeParse(story.theme);
  if (!themeParse.success) {
    console.error("[story_suggest] theme drift", {
      storyId: story.id,
      theme: story.theme,
      issues: themeParse.error.issues,
    });
    return NextResponse.json(
      {
        error: "service_unavailable",
        message:
          "AI draft generation is temporarily unavailable for this story's theme.",
      },
      { status: 503 },
    );
  }
  const groundedTheme = themeParse.data;

  // Per-story content gate. 10/24h. Independent counter from
  // both rebuild-side gates.
  try {
    assertStorySuggestRateOk(story);
  } catch (err) {
    if (err instanceof StorySuggestRateLimitError) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: `You've used ${err.limit} AI drafts on this story in the last 24 hours.`,
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

  // Run the suggestion. The runner returns a synthetic fallback
  // (passedGuardrails: false) on parse / validation / verbatim
  // guardrail failures rather than throwing, so the user always
  // sees something — even if we then refuse to persist or charge
  // for it.
  let result;
  try {
    result = await runSuggestResponse({
      context: {
        userId: story.userId,
        questionText: story.title,
        // Validated above via `rebuildQuestionThemeSchema` — no
        // unchecked cast.
        questionTheme: groundedTheme,
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

  // Profile-empty short-circuit: the candidate has no usable
  // profile content. Return 422 so the client shows a "fill in
  // your profile first" panel. No charge, no persistence.
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

  // Synthetic-fallback short-circuit. Don't persist (preserves
  // any prior cached suggestion); don't bump the rate gate; don't
  // charge. Surface the synthetic body so the client can render
  // a "try again" caveat.
  if (!result.passedGuardrails) {
    console.warn("[story_suggest] guardrail tripped", {
      storyId: story.id,
      reason: result.guardrailReason ?? "(unspecified)",
    });
    trackServerEvent({
      distinctId: userId,
      event: ANALYTICS_EVENTS.storySuggestedResponseGuardrailTripped,
      properties: { reason: result.guardrailReason ?? null },
    });
    // Defensively parse the cached JSONB before echoing — a
    // corrupted historical row (manual SQL, partial migration)
    // shouldn't be returned to the client and rendered raw.
    let cachedAiSuggestedResponse: typeof result.suggestion | null = null;
    if (story.aiSuggestedResponseJson != null) {
      const parsed = suggestedResponseSchema.safeParse(
        story.aiSuggestedResponseJson,
      );
      cachedAiSuggestedResponse = parsed.success ? parsed.data : null;
    }
    return NextResponse.json(
      {
        story: { id: story.id },
        syntheticSuggestion: result.suggestion,
        passedGuardrails: false,
        aiSuggestedResponse: cachedAiSuggestedResponse,
        aiSuggestedResponseGeneratedAt: cachedAiSuggestedResponse
          ? story.aiSuggestedResponseGeneratedAt?.toISOString() ?? null
          : null,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store, must-revalidate" },
      },
    );
  }

  // Persist + charge. Pinned timestamp so the gate and analytics
  // read a deterministic value.
  const at = new Date();
  const applied = await applyStorySuggestedResponse({
    storyId: story.id,
    userId,
    suggestion: result.suggestion,
    modelVersion: result.modelVersion,
    at,
  });
  if (!applied.ok) {
    // Stories don't have a `wrong_state` lifecycle — the only
    // way to land here is a row that vanished between load and
    // apply (rare but possible if a delete races us).
    return NOT_FOUND();
  }

  const updated = applied.row;

  trackServerEvent({
    distinctId: userId,
    event: ANALYTICS_EVENTS.storySuggestedResponseRequested,
    properties: {
      story_id: story.id,
      suggestion_runs_last_24h: countStorySuggestionsInLast24h(updated, at),
      passed_guardrails: true,
      model_version: result.modelVersion,
      prompt_version: result.promptVersion,
      sources_count: result.suggestion.sources.length,
      caveats_count: result.suggestion.caveats.length,
    },
  });

  return NextResponse.json(
    {
      story: { id: updated.id },
      syntheticSuggestion: null,
      passedGuardrails: true,
      aiSuggestedResponse: result.suggestion,
      aiSuggestedResponseGeneratedAt: at.toISOString(),
    },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}
