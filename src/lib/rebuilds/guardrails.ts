import "server-only";

import type { RebuildProfileContext } from "./profile-context";
import type {
  CritiqueResponse,
  DimensionFeedback,
} from "./schemas";

/**
 * Post-LLM guardrails that run on every validated critique BEFORE
 * we store it or return it to the user. The spec defines four
 * distinct trip-types; each emits a unique event name so we can
 * trend the failure modes separately.
 *
 *   1. No example sentences  — the AI must NOT propose verbatim
 *                              wording the candidate could read
 *                              aloud.
 *   2. No hallucinated profile content — every
 *      `profile_reference.field_value` must appear verbatim in
 *      the source profile snapshot we sent in the prompt.
 *   3. No suggestion-without-ownership-check — for the two
 *      profile-grounded dimensions, the `what_to_check` field
 *      must contain an ownership-verification phrasing.
 *   4. No mismatched strong + profile_reference — `status:
 *      'strong'` items don't need profile pointers; this catches
 *      drift where the model attaches unnecessary suggestions.
 *
 * On a trip we DO NOT show the failed critique to the user. The
 * caller (`runCritique`) falls back to a basic structural critique
 * with `profile_reference` fields stripped and emits the trip event
 * to the application log. This is asymmetric on purpose: a coach that
 * occasionally has nothing useful to say is fine; a coach that
 * fabricates evidence is not.
 */

/**
 * One event-name per guardrail. Used by the caller to label the
 * analytics trip — and asserted by tests so the names can't
 * silently churn.
 */
export const GUARDRAIL_EVENTS = {
  exampleSentence: "rebuild_guardrail_example_sentence",
  hallucinatedProfile: "rebuild_guardrail_hallucinated_profile",
  missingOwnershipCheck: "rebuild_guardrail_missing_ownership_check",
  strongWithProfileRef: "rebuild_guardrail_strong_with_profile_ref",
} as const;

export type GuardrailEvent =
  (typeof GUARDRAIL_EVENTS)[keyof typeof GUARDRAIL_EVENTS];

export interface GuardrailFailure {
  event: GuardrailEvent;
  /**
   * Human-readable reason the guardrail tripped. Logged for
   * diagnostics; never shown to the candidate.
   */
  reason: string;
  /** The dimension index that triggered the failure, when applicable. */
  dimensionIndex?: number;
}

export interface GuardrailResult {
  ok: boolean;
  failures: GuardrailFailure[];
}

/**
 * Disallowed phrasings for guardrail 1. Lower-cased; matched
 * case-insensitively. Pinned by the spec and asserted by tests.
 */
const EXAMPLE_PHRASES = [
  "for example, you could say",
  "try saying",
  "consider this wording",
  "an example response would be",
  "you might say something like",
];

/**
 * Phrases acceptable for the ownership-verification check
 * (guardrail 3). Any one of these in `what_to_check` is enough.
 * Lower-cased; matched case-insensitively.
 */
const OWNERSHIP_PHRASES = [
  "if you",
  "whether you",
  "did you",
  "can you speak to",
  "verify",
  "check whether",
  "confirm",
];

/**
 * The dimensions that REQUIRE an ownership-verification phrase in
 * `what_to_check`. Single source of truth; the spec ties this to
 * `profile_consistency` and `profile_leverage`.
 */
const OWNERSHIP_REQUIRED_DIMENSIONS = new Set([
  "profile_consistency",
  "profile_leverage",
]);

/**
 * Detect a quoted-sentence pattern that looks like "model
 * sentence the candidate could read aloud." Heuristic: a quoted
 * span (curly or straight) of 5+ words containing a sentence-
 * terminating punctuation mark. Pinned in tests.
 */
const QUOTED_FULL_SENTENCE_RE =
  /["“][^"”]{0,400}?(?:\b\w+\b[\s,;-]*){5,}[.!?][^"”]{0,30}?["”]/i;

/**
 * Run all four guardrails against a validated critique. Returns
 * `ok: true` AND `failures: []` only when every dimension passes.
 * On any failure, the caller falls back to a basic critique with
 * `profile_reference` fields stripped and emits the trip event(s)
 * to the application log.
 */
export function runGuardrails(args: {
  critique: CritiqueResponse;
  profile: RebuildProfileContext;
}): GuardrailResult {
  const failures: GuardrailFailure[] = [];

  for (let i = 0; i < args.critique.dimension_feedback.length; i++) {
    const fb = args.critique.dimension_feedback[i]!;

    /* ── Guardrail 1: no example sentences ───────────────── */
    const exampleHit = findExampleSentence(fb.what_to_check);
    if (exampleHit) {
      failures.push({
        event: GUARDRAIL_EVENTS.exampleSentence,
        reason: `dimension '${fb.dimension}': what_to_check contained ${exampleHit}`,
        dimensionIndex: i,
      });
    }

    /* ── Guardrail 2: profile content not hallucinated ──── */
    if (fb.profile_reference) {
      if (!profileContains(args.profile, fb.profile_reference.field_value)) {
        failures.push({
          event: GUARDRAIL_EVENTS.hallucinatedProfile,
          reason:
            `dimension '${fb.dimension}': profile_reference.field_value not present verbatim in source profile (claimed path: ${fb.profile_reference.field_path})`,
          dimensionIndex: i,
        });
      }
    }

    /* ── Guardrail 3: ownership-verification required ────── */
    if (
      OWNERSHIP_REQUIRED_DIMENSIONS.has(fb.dimension) &&
      !hasOwnershipPhrase(fb.what_to_check)
    ) {
      failures.push({
        event: GUARDRAIL_EVENTS.missingOwnershipCheck,
        reason: `dimension '${fb.dimension}': what_to_check lacks an ownership-verification phrasing`,
        dimensionIndex: i,
      });
    }

    /* ── Guardrail 4: strong items don't carry profile_reference ── */
    if (fb.status === "strong" && fb.profile_reference) {
      failures.push({
        event: GUARDRAIL_EVENTS.strongWithProfileRef,
        reason:
          `dimension '${fb.dimension}': status='strong' but profile_reference is present (drift toward unsolicited suggestion)`,
        dimensionIndex: i,
      });
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Test for the example-sentence patterns in `text`. Returns a
 * short tag describing which pattern hit (used in the failure
 * reason for triage), or `null` when nothing matched.
 *
 * Exported so tests can hit each pattern individually.
 */
export function findExampleSentence(text: string): string | null {
  const lower = text.toLowerCase();
  for (const phrase of EXAMPLE_PHRASES) {
    if (lower.includes(phrase)) {
      return `forbidden phrase '${phrase}'`;
    }
  }
  if (QUOTED_FULL_SENTENCE_RE.test(text)) {
    return "quoted full-sentence pattern";
  }
  return null;
}

/**
 * Returns `true` iff at least one of the OWNERSHIP_PHRASES
 * appears in `text` (case-insensitive). Exported for tests.
 */
export function hasOwnershipPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return OWNERSHIP_PHRASES.some((p) => lower.includes(p));
}

/**
 * Whitespace-normalised verbatim search: returns `true` iff
 * `needle` appears in any of the candidate's profile slabs after
 * collapsing whitespace. The render layer (`renderProfileContext`)
 * already collapses whitespace on the way INTO the prompt, so the
 * model's "verbatim" obligation is against the collapsed shape.
 *
 * Exported for tests.
 */
export function profileContains(
  profile: RebuildProfileContext,
  needle: string,
): boolean {
  const normNeedle = normalizeForVerbatim(needle);
  if (normNeedle.length === 0) return false;

  // Build the haystack from every textual surface the prompt
  // exposes. Concatenate with a separator the needle can't
  // straddle (a literal `\u0001` byte) so a forged needle that
  // bridges two adjacent fields can't accidentally match.
  const SEP = "\u0001";
  const parts: string[] = [];

  if (profile.resume) {
    parts.push(profile.resume.careerNarrative ?? "");
    parts.push(profile.resume.professionalSummary ?? "");
    parts.push(profile.resume.currentRole ?? "");
    parts.push(profile.resume.yearsOfExperience?.toString() ?? "");
    if (Array.isArray(profile.resume.levels)) {
      parts.push(profile.resume.levels.join(", "));
    }
    if (Array.isArray(profile.resume.targetCompanies)) {
      parts.push(profile.resume.targetCompanies.join(", "));
    }
  }

  for (const p of profile.projects) {
    parts.push(p.name ?? "");
    parts.push(p.companyContext ?? "");
    parts.push(p.timePeriod ?? "");
    parts.push(p.scaleDescription ?? "");
    parts.push(p.teamSize ?? "");
    parts.push(p.myRole ?? "");
    parts.push(p.keyDecisions ?? "");
    parts.push(p.outcomesWithMetrics ?? "");
  }

  for (const s of profile.stories) {
    parts.push(s.title ?? "");
    parts.push(s.situation ?? "");
    parts.push(s.task ?? "");
    parts.push(s.action ?? "");
    parts.push(s.result ?? "");
    parts.push(s.whatILearned ?? "");
  }

  const haystack = normalizeForVerbatim(parts.join(SEP));
  return haystack.includes(normNeedle);
}

/**
 * Collapse whitespace runs to a single space and lower-case for
 * case-insensitive comparison. Exported so the verbatim test
 * fixtures can pin the same normalization.
 */
export function normalizeForVerbatim(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Build a "basic structural critique" — the spec's fall-back
 * shape when guardrails trip. The shape:
 *
 *   - Drops every `profile_reference` (the load-bearing trip
 *     case is hallucinated profile content; even when only
 *     guardrail 1 trips, we still strip the references rather
 *     than surface a partially-discredited critique).
 *   - Replaces `what_to_check` for the two profile dimensions
 *     with a generic, instructional sentence so the candidate
 *     still gets some signal.
 *   - Keeps overall_assessment and next_step_suggestion intact
 *     when they pass guardrail 1; replaces them otherwise.
 *
 * The candidate is never told a guardrail tripped (that's an
 * internal alarm). They just see a slightly thinner critique.
 */
export function buildFallbackCritique(args: {
  original: CritiqueResponse;
  failures: GuardrailFailure[];
}): CritiqueResponse {
  const overallTripped = findExampleSentence(args.original.overall_assessment) != null;
  const nextStepTripped =
    findExampleSentence(args.original.next_step_suggestion) != null;

  const cleanedDimensions: DimensionFeedback[] =
    args.original.dimension_feedback.map((fb) => {
      const cleaned: DimensionFeedback = {
        dimension: fb.dimension,
        status: fb.status === "strong" ? "strong" : fb.status,
        quoted_excerpt: fb.quoted_excerpt,
        what_to_check: fb.what_to_check,
        // profile_reference deliberately omitted in the fallback.
      };

      // If the original `what_to_check` had an example sentence,
      // replace it with a generic instructional fall-back. The
      // structural feedback still applies to whatever the user
      // wrote.
      if (findExampleSentence(fb.what_to_check) != null) {
        cleaned.what_to_check = genericWhatToCheck(fb);
      } else if (
        OWNERSHIP_REQUIRED_DIMENSIONS.has(fb.dimension) &&
        !hasOwnershipPhrase(fb.what_to_check)
      ) {
        // Guardrail 3 trip — the model gave a profile suggestion
        // without an ownership check. We don't have a profile_
        // reference attached anymore (stripped above), so the
        // generic phrasing is the safe replacement.
        cleaned.what_to_check = genericWhatToCheck(fb);
      }

      return cleaned;
    });

  return {
    overall_assessment: overallTripped
      ? "Your draft is structured below. Read each dimension and revise where the structural feedback applies."
      : args.original.overall_assessment,
    dimension_feedback: cleanedDimensions,
    next_step_suggestion: nextStepTripped
      ? "Revise the field flagged as 'missing' or 'needs_work' first — those move the structure most."
      : args.original.next_step_suggestion,
  };
}

function genericWhatToCheck(fb: DimensionFeedback): string {
  switch (fb.dimension) {
    case "profile_consistency":
      return "Re-read your draft against your profile and confirm the specifics (company, role, team size, dates) match. If they don't, decide which is correct.";
    case "profile_leverage":
      return "Look at your profile (projects and stories) and check whether you have a more specific piece of evidence for this part of the answer than what your draft contains. If you do, ask yourself whether you personally owned it before adding it to the draft.";
    case "headline":
      return "Check whether your headline states the single main point of the answer in one sentence.";
    case "star_completeness":
      return "Check whether Situation, Task, Action, and Result are each present and distinct in your draft.";
    case "first_person":
      return "Check whether you used 'I' for your specific decisions and not 'we' for the parts you personally did.";
    case "quantification":
      return "Check whether your Result includes a specific measurable outcome (number, percentage, time delta, headcount).";
    case "behavioral_change":
      return "Check whether your 'what I'd do differently' names a specific behavior change rather than a vague intention.";
    default:
      return "Re-read this section and consider whether the structural feedback applies.";
  }
}
