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
import { rebuildQuestionThemeSchema } from "@/lib/db/schema";
import { LlmNotConfiguredError } from "@/lib/llm";
import { rebuildCritiqueLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { runSuggestResponse } from "@/lib/rebuilds";

/**
 * POST /api/stories/draft-suggestion
 *
 * Ephemeral, no-persistence draft generation used by the
 * Add-Story form. The user types a title and picks a theme;
 * clicking "Generate AI draft" calls this endpoint, which runs
 * the same Haiku pipeline as the saved-story / rebuild surfaces
 * but does NOT write anything to the database — the suggestion
 * lives only in the form's client-state and is dropped if the
 * user cancels or saves with their own STAR text.
 *
 * Why ephemeral rather than create-then-suggest?
 *
 *   - The user is mid-form. They haven't committed to keeping
 *     this story yet (they can hit Cancel). Persisting an
 *     incomplete story just to attach a suggestion would leave
 *     orphaned drafts in the bank if they bail.
 *
 *   - The natural UX is "AI fills my form, I edit, I save". The
 *     user's edits become the canonical STAR fields on save; the
 *     pre-edit AI body is intentionally not preserved (it's the
 *     same as the user's draft modulo their edits). Once the
 *     story is saved, the user can click "Generate AI suggested
 *     response" on the resulting card to get a fresh comparison
 *     draft (which IS persisted).
 *
 * Auth + same-origin + burst-limiter posture mirrors the saved-
 * story route. Credit charge: yes — we're calling Haiku, the
 * cost is real, and shipping a draft to the form is the value
 * the user is paying for. Rate gate: NONE per-story (the story
 * doesn't exist yet); the per-user burst limiter (12/5min)
 * prevents spamming.
 *
 * Synthetic-fallback: no charge, surface the synthetic body so
 * the form can show a "try again" caveat. Unlike the saved-
 * story / rebuild surfaces, there's no persistence to skip — by
 * design.
 */

const MAX_BODY_BYTES = 4 * 1024;

const bodySchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title is required to ground the AI draft.")
    .max(200, "Title too long for an interview question."),
  theme: rebuildQuestionThemeSchema,
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

  // Per-user burst layer — same limiter the rebuild + saved-
  // story surfaces use. A user spamming this endpoint can't
  // exceed 12 calls per 5 minutes.
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

  // Body parse with a hard byte cap so a misbehaving client
  // can't ship a megabyte of "title" through the LLM prompt.
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
        message: "Title and theme are required.",
        issues: parsedBody.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }
  const { title, theme } = parsedBody.data;

  // Credit preflight. Same accumulator as the rebuild + saved-
  // story surfaces.
  let costPreview: Awaited<
    ReturnType<typeof previewRebuildCritiqueCost>
  >;
  try {
    costPreview = await previewRebuildCritiqueCost({ userId });
  } catch (err) {
    console.error("[story_draft_preflight]", err);
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
          `You're out of credits. Each AI draft costs ${REBUILD_CRITIQUE_CREDIT_COST.toFixed(2)} credits ` +
          `— top up to keep practicing.`,
        required: costPreview.wouldChargeCredits,
        available: costPreview.currentBalance,
        perCritiqueCost: REBUILD_CRITIQUE_CREDIT_COST,
      },
      { status: 402 },
    );
  }

  let result;
  try {
    result = await runSuggestResponse({
      context: {
        userId,
        questionText: title,
        // `theme` is already typed as `RebuildQuestionTheme` by
        // the zod parse above (`rebuildQuestionThemeSchema` is
        // the canonical schema for this union). No cast needed.
        questionTheme: theme,
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

  // Profile-empty short-circuit: same as the rebuild + saved-story
  // surfaces. Return 422 before displaying any generic content.
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

  // Synthetic-fallback path: skip the charge, return the
  // synthetic body so the UI can show a "try again" caveat. No
  // persistence to skip — by design.
  if (!result.passedGuardrails) {
    console.warn("[story_draft] guardrail tripped", {
      reason: result.guardrailReason ?? "(unspecified)",
    });
    return NextResponse.json(
      {
        suggestion: result.suggestion,
        passedGuardrails: false,
        creditsCharged: 0 as const,
        balanceAfter: null,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store, must-revalidate" },
      },
    );
  }

  let creditsCharged: 0 | 1 = 0;
  let balanceAfter: number | null = null;
  try {
    const charge = await chargeRebuildCritique({
      userId,
      // Form-time surface: no entity id (the story hasn't been
      // saved yet). The audit row's `event_type` is
      // `story_draft.credit_charged` so dispute resolution can
      // tell these apart from saved-story charges.
      surface: { kind: "story_draft" },
    });
    creditsCharged = charge.creditsCharged;
    balanceAfter = charge.balanceAfter;
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      console.warn("[story_draft] charge race skipped", {
        required: err.required,
        available: err.available,
      });
    } else {
      console.error("[story_draft_charge]", err);
    }
  }

  trackServerEvent({
    distinctId: userId,
    event: ANALYTICS_EVENTS.storyDraftGenerated,
    properties: {
      theme,
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
      suggestion: result.suggestion,
      passedGuardrails: true,
      creditsCharged,
      balanceAfter,
    },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}
