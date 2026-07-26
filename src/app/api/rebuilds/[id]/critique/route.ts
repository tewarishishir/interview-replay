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
import { isSameOrigin } from "@/lib/same-origin";
import {
  applyCritique,
  assertCritiqueRateOk,
  countCritiquesInLast24h,
  getRebuild,
  RebuildCritiquePreflightError,
  RebuildCritiqueRateLimitError,
  runCritique,
  toRebuildDto,
} from "@/lib/rebuilds";

/**
 * POST /api/rebuilds/:id/critique
 *
 * Run a fresh critique against the candidate's draft. Steps:
 *
 *   1. Same-origin + active user (no exceptions; a soft-deleted
 *      user must not be able to burn LLM credit on their JWT's
 *      remaining lifetime).
 *   2. Per-user burst limiter (`rebuildCritiqueLimiter`) caps
 *      the cross-rebuild churn — guards against a stuck client
 *      hammering Get Critique across 11 different rebuilds in a
 *      minute.
 *   3. Load + ownership-check the rebuild row.
 *   4. Per-rebuild 10/24h gate (`assertCritiqueRateOk`). Throws
 *      RebuildCritiqueRateLimitError → 429 with Retry-After.
 *   5. `runCritique` — talks to the LLM, validates, runs
 *      guardrails, returns either the model's response or a
 *      fallback critique with profile_reference fields stripped.
 *   6. On guardrail trips, emit one log event per trip (the
 *      runner doesn't do side effects).
 *   7. `applyCritique` persists the result + pushes the prior
 *      critique onto critique_history.
 *   8. Fire analytics events: critique_requested,
 *      profile_leverage_surfaced, profile_discrepancy_flagged.
 *
 * Credit charging (added after launch — every critique calls
 * the LLM, so making it free was an unbounded LLM-spend hole):
 *
 *   - Each critique costs 0.20 credits, accumulated in
 *     `users.rebuild_critique_units`. Every 5th critique deducts
 *     one whole credit and writes a `rebuild_critique_charge`
 *     ledger row. `chargeRebuildCritique` is the single mutator.
 *   - We preflight the cost (`previewRebuildCritiqueCost`) BEFORE
 *     the LLM round-trip so an out-of-credits user gets a 402
 *     instead of a "we paid for the LLM call but couldn't bill you" race.
 *   - We charge AFTER `applyCritique` succeeds, regardless of
 *     `passedGuardrails`. Fallback critiques (guardrail trip →
 *     stripped basic critique, OR LLM-validation-failed → synthetic
 *     structural critique) STILL get billed because:
 *       (a) we already paid for the LLM round-trip, and
 *       (b) `applyCritique` persists the fallback so the user
 *           sees a real, structured critique on screen — not just
 *           a placeholder. From the user's perspective each click
 *           "Costs 0.20 credits per critique" (the literal CTA
 *           copy), and inconsistently skipping the charge on
 *           guardrail trips made the deduction look broken from
 *           the user's POV ("I clicked, got a critique, balance
 *           didn't move").
 *     Pre-LLM errors (preflight missing fields, 503 LLM
 *     unavailable, 402 out-of-credits) still don't charge — those
 *     short-circuit BEFORE the LLM call and never get to
 *     `applyCritique`.
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

  // Per-user burst layer. The per-rebuild 10/24h gate runs after
  // we've loaded the row — both layers stack.
  const burst = await rebuildCritiqueLimiter().check(userId);
  if (!burst.success) {
    const retryAfter = Math.max(1, Math.ceil((burst.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many critique requests in a short period. Try again shortly.",
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return NOT_FOUND();

  const rebuild = await getRebuild(parsedParams.data.id, userId);
  if (!rebuild) return NOT_FOUND();

  // Lifecycle gate. Critiquing a `saved_to_bank` rebuild would
  // diverge it from the promoted story (and re-flip the status,
  // detaching the audit trail); critiquing a `discarded` rebuild
  // would resurrect a soft-deleted draft just before the
  // retention sweep was about to purge it. Both are 409 — distinct
  // from the 404 we use for "not yours / not there".
  if (rebuild.status === "saved_to_bank" || rebuild.status === "discarded") {
    return NextResponse.json(
      {
        error: "rebuild_wrong_state",
        message:
          "This rebuild can no longer be critiqued — it has been saved to your story bank or discarded.",
        status: rebuild.status,
      },
      { status: 409 },
    );
  }

  // Funnel signal: BEFORE the new critique runs, check whether
  // the user's current draft (the post-revision state) now
  // contains any `profile_reference.field_value` text we surfaced
  // in the previous critique. If so, fire
  // `rebuild_profile_suggestion_actioned` once so product can
  // measure the "did the user actually take a profile-grounded
  // suggestion" rate. We only fire when there IS a previous
  // critique — first runs are baseline, not actioned.
  //
  // Implementation note: this is intentionally a coarse
  // string-contains check, not a fuzzy match. The spec calls for
  // a "simple string-contains check"; better-than-that is a
  // future-product question and would change the metric meaning
  // mid-flight.
  emitSuggestionActionedIfApplicable({ userId, rebuild });

  // Per-rebuild content gate. 10/24h. The throw carries
  // `retryAfterSeconds` we use directly in the 429 response.
  try {
    assertCritiqueRateOk(rebuild);
  } catch (err) {
    if (err instanceof RebuildCritiqueRateLimitError) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: `You've used ${err.limit} critiques on this rebuild in the last 24 hours.`,
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

  // Credit preflight. The cost is tracked as a fractional accumulator
  // on `users.rebuild_critique_units`; every Nth critique
  // (`REBUILD_CRITIQUE_UNITS_PER_CREDIT`) would deduct one whole
  // credit. We refuse the call BEFORE the LLM round-trip when the
  // user can't afford that rollover charge — no point burning an
  // LLM call just to fail at billing time.
  //
  // The authoritative check happens transactionally inside
  // `chargeRebuildCritique` (FOR UPDATE on the user row) — this
  // preflight is the cheap optimization to avoid the LLM call. A
  // race where the balance drops between this check and the post-
  // critique charge is handled by the catch block around the charge:
  // the critique gets served (we already paid for the LLM call) and the
  // race is logged.
  let costPreview: Awaited<
    ReturnType<typeof previewRebuildCritiqueCost>
  >;
  try {
    costPreview = await previewRebuildCritiqueCost({ userId });
  } catch (err) {
    // Defensive: the helper throws on out-of-range accumulator values
    // (schema drift) or DB outages. We don't want a stack-leaking
    // 500 — log the error and serve a generic 503 the user can retry.
    console.error("[rebuild_critique_preflight]", err);
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
    // User row was soft-deleted between `getActiveUserId` and now.
    // The session cookie outlived the deletion; treat as unauthenticated
    // so the client clears the cookie and re-signs in.
    return UNAUTHORIZED();
  }
  if (!costPreview.canAffordNext) {
    return NextResponse.json(
      {
        error: "insufficient_credits",
        message:
          `You're out of credits. Each critique costs ${REBUILD_CRITIQUE_CREDIT_COST.toFixed(2)} credits ` +
          `— top up to keep practicing.`,
        required: costPreview.wouldChargeCredits,
        available: costPreview.currentBalance,
        perCritiqueCost: REBUILD_CRITIQUE_CREDIT_COST,
      },
      { status: 402 },
    );
  }

  // Run the critique. The runner throws preflight errors when
  // the draft is too thin; we map those to a 400 with the
  // missing-field list so the UI can underline the empty
  // textareas.
  //
  // It does NOT throw on schema-validation failure anymore —
  // instead it returns a synthetic fallback critique with
  // `passedGuardrails: false`. That keeps the user out of the
  // "We couldn't generate a critique for this draft" loop they
  // were stuck in when Haiku occasionally returned non-JSON. The
  // synthetic failure rides the same `guardrailFailures[]`
  // channel as guardrail trips, so the logging instrumentation
  // below logs it for on-call without a second code path.
  let result;
  try {
    result = await runCritique({ rebuild });
  } catch (err) {
    if (err instanceof RebuildCritiquePreflightError) {
      return NextResponse.json(
        {
          error: "draft_incomplete",
          message:
            "Tell us your situation, action, and result before we can critique your draft.",
          missing: err.missing,
        },
        { status: 400 },
      );
    }
    if (err instanceof LlmNotConfiguredError) {
      return NextResponse.json(
        {
          error: "llm_unavailable",
          message:
            "Critique is temporarily unavailable in this environment.",
        },
        { status: 503 },
      );
    }
    throw err;
  }

  // Guardrail trips → one log event per failure so trip-rate
  // dashboards bucket them by event name. We include the rebuild
  // id and the failure reason in the breadcrumb but never the
  // candidate's draft or the model's raw response (those are
  // sensitive content).
  if (!result.passedGuardrails) {
    for (const failure of result.guardrailFailures) {
      console.warn(`[rebuild_critique] guardrail tripped: ${failure.event}`, {
        rebuildId: rebuild.id,
        reason: failure.reason,
      });
      trackServerEvent({
        distinctId: userId,
        event: ANALYTICS_EVENTS.rebuildGuardrailTripped,
        properties: {
          guardrail: failure.event,
          dimension_index: failure.dimensionIndex ?? null,
        },
      });
    }
  }

  // Persist the (possibly fallback) critique + update history.
  // The persist layer uses the timestamp we pass for the new
  // entry so analytics + the daily gate can read a deterministic
  // value back without a race against `now()`.
  const at = new Date();
  const applied = await applyCritique({
    rebuildId: rebuild.id,
    userId,
    critique: result.critique,
    at,
  });
  if (!applied.ok) {
    if (applied.reason === "wrong_state") {
      // Race between our status guard above and the tx — the
      // rebuild moved to discarded/saved_to_bank during the LLM
      // round-trip. Return 409 instead of swallowing the LLM
      // result silently.
      return NextResponse.json(
        {
          error: "rebuild_wrong_state",
          message:
            "This rebuild was saved or discarded while we were generating its critique.",
        },
        { status: 409 },
      );
    }
    // Row deleted between load and apply. 404 is the closest
    // user-facing answer; the user can retry.
    return NOT_FOUND();
  }

  const updated = applied.row;

  // Charge the user for the critique. Runs regardless of
  // `passedGuardrails` because `applyCritique` above persisted
  // SOMETHING the user can act on:
  //   - guardrails passed → the model's real response.
  //   - guardrails tripped → `buildFallbackCritique` produced a
  //     stripped-but-still-structural critique (5 dimensions of
  //     feedback the candidate can self-review against).
  //   - LLM validation failed → `buildSyntheticValidationFallback`
  //     produced the same shape (also persisted).
  // In all three branches we paid for the LLM call AND the user sees a
  // real critique view, so the literal CTA copy "Costs 0.20
  // credits per critique" needs to hold on every successful click
  // — anything else looks like a billing bug to the user.
  //
  // The route's earlier preflight (`previewRebuildCritiqueCost`)
  // makes the rollover-without-balance case rare; landing in the
  // `InsufficientCreditsError` catch here means a race where the
  // balance dropped during the LLM call. We log + serve the
  // critique anyway — we don't have a good way to "un-call" the
  // model, and forcing the user to re-pay for a critique they
  // already saw is worse UX than swallowing the occasional sub-
  // cent loss.
  let creditsCharged: 0 | 1 = 0;
  let balanceAfter: number | null = null;
  try {
    const charge = await chargeRebuildCritique({
      userId,
      rebuildId: rebuild.id,
    });
    creditsCharged = charge.creditsCharged;
    balanceAfter = charge.balanceAfter;
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      console.warn("[rebuild_critique] charge race skipped", {
        rebuildId: rebuild.id,
        required: err.required,
        available: err.available,
      });
    } else {
      console.error("[rebuild_critique_charge]", err);
    }
  }

  // Analytics: critique_requested with the run number (1st, 2nd,
  // …). After applyCritique, totalRuns = (history.length + 1).
  // We reuse `countCritiquesInLast24h` so the 24h count is
  // computed once consistently.
  const dto = toRebuildDto(updated);

  trackServerEvent({
    distinctId: userId,
    event: ANALYTICS_EVENTS.rebuildCritiqueRequested,
    properties: {
      critique_count: dto.critiqueRunCount,
      critique_runs_last_24h: countCritiquesInLast24h(updated, at),
      passed_guardrails: result.passedGuardrails,
      model_version: result.modelVersion,
      prompt_version: result.promptVersion,
      credits_charged: creditsCharged,
    },
  });

  // Per-event analytics for the two profile-grounded dimensions
  // — these drive the health-metric dashboards (the spec calls
  // out an 80% upper bound and 20% lower bound on
  // profile_suggestion_actioned rate; you can't compute that
  // ratio without these denominators).
  const leverageCount = result.critique.dimension_feedback.filter(
    (d) =>
      d.dimension === "profile_leverage" && d.profile_reference !== undefined,
  ).length;
  if (leverageCount > 0) {
    trackServerEvent({
      distinctId: userId,
      event: ANALYTICS_EVENTS.rebuildProfileLeverageSurfaced,
      properties: { count: leverageCount },
    });
  }
  const discrepancyCount = result.critique.dimension_feedback.filter(
    (d) =>
      d.dimension === "profile_consistency" && d.status === "discrepancy",
  ).length;
  if (discrepancyCount > 0) {
    trackServerEvent({
      distinctId: userId,
      event: ANALYTICS_EVENTS.rebuildProfileDiscrepancyFlagged,
      properties: { count: discrepancyCount },
    });
  }

  // Wire the (small) failure-summary metadata back so QA can
  // distinguish "got the model's response" from "got a fallback"
  // in browser devtools without leaking guardrail reasons.
  // `creditsCharged` + `balanceAfter` let the UI optimistically
  // refresh the balance pill without a follow-up fetch (and tell
  // the user when an accumulated rollover charge actually fired).
  return NextResponse.json(
    {
      rebuild: dto,
      passedGuardrails: result.passedGuardrails,
      guardrailTripCount: result.guardrailFailures.length,
      creditsCharged,
      balanceAfter,
    },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}

/**
 * Best-effort funnel signal: did the user's revised draft
 * incorporate any `profile_reference.field_value` we surfaced in
 * the PREVIOUS critique? If so, fire one
 * `rebuild_profile_suggestion_actioned` event with how many
 * matched. We bucket the count instead of emitting one event per
 * match so the funnel rate reads cleanly.
 *
 * Implementation:
 *   - Pull the prior critique off `rebuild.aiCritiqueJson`. If
 *     missing or malformed, this is a first-run critique and we
 *     emit nothing.
 *   - For each `dimension_feedback[i].profile_reference?.field_value`,
 *     normalize whitespace + case (matching the same approach the
 *     guardrail uses) and check `String.includes` against each
 *     STAR field on the current rebuild.
 *
 * Caveats:
 *   - A short field_value (a single token) will trip too easily
 *     ("the team" appears everywhere). We require ≥ 12 chars.
 *   - We don't try to attribute which specific suggestion was
 *     actioned — that would require keeping the `index` on the
 *     event and isn't useful for the funnel.
 */
function emitSuggestionActionedIfApplicable(args: {
  userId: string;
  rebuild: Parameters<typeof toRebuildDto>[0];
}): void {
  const prior = args.rebuild.aiCritiqueJson;
  if (!prior || typeof prior !== "object") return;
  const dims = (prior as { dimension_feedback?: unknown }).dimension_feedback;
  if (!Array.isArray(dims)) return;

  const draftFields = [
    args.rebuild.headline,
    args.rebuild.situation,
    args.rebuild.task,
    args.rebuild.action,
    args.rebuild.result,
    args.rebuild.whatIWouldChange,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map(normalize)
    .join(" \n ");

  if (!draftFields) return;

  let matched = 0;
  for (const d of dims) {
    if (!d || typeof d !== "object") continue;
    const ref = (d as { profile_reference?: { field_value?: unknown } })
      .profile_reference;
    const value = ref?.field_value;
    if (typeof value !== "string") continue;
    const norm = normalize(value);
    // Avoid false positives on very short values like "I" / "we".
    if (norm.length < 12) continue;
    if (draftFields.includes(norm)) matched++;
  }

  if (matched > 0) {
    trackServerEvent({
      distinctId: args.userId,
      event: ANALYTICS_EVENTS.rebuildProfileSuggestionActioned,
      properties: { matched },
    });
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
