import { describe, expect, it } from "vitest";

import type { CritiqueResponse } from "@/lib/rebuilds/schemas";
import type { RebuildProfileContext } from "@/lib/rebuilds/profile-context";
import {
  GUARDRAIL_EVENTS,
  buildFallbackCritique,
  findExampleSentence,
  hasOwnershipPhrase,
  normalizeForVerbatim,
  profileContains,
  runGuardrails,
} from "@/lib/rebuilds/guardrails";

/**
 * Guardrail unit tests.
 *
 * Each of the four guardrails has a directed test that mocks the
 * minimal critique shape the spec calls out. We assert on the
 * `failures[].event` enum (not the reason text) — the reason is a
 * diagnostic and may evolve.
 *
 * The fallback builder gets coverage too: the spec calls for a
 * thinner-but-usable critique on a trip, which means
 * `profile_reference` MUST be stripped from every dimension and
 * the two profile dimensions MUST get a benign `what_to_check`.
 */

const baseProfile: RebuildProfileContext = {
  resume: null,
  projects: [],
  stories: [],
};

function feedback(over: Partial<
  CritiqueResponse["dimension_feedback"][number]
>): CritiqueResponse["dimension_feedback"][number] {
  return {
    dimension: "headline",
    status: "needs_work",
    quoted_excerpt: "",
    what_to_check: "consider whether the headline is concrete",
    ...over,
  };
}

function critique(
  feedbacks: CritiqueResponse["dimension_feedback"],
): CritiqueResponse {
  return {
    overall_assessment: "Solid scaffolding, missing a metric.",
    dimension_feedback: feedbacks,
    next_step_suggestion: "Pick the single biggest measurable result.",
  };
}

describe("guardrail 1: no example sentences", () => {
  it("trips on every spec'd forbidden phrase", () => {
    const phrases = [
      "for example, you could say something here",
      "Try saying it more concisely",
      "consider this wording instead",
      "an example response would be useful",
      "you might say something like next time",
    ];
    for (const wt of phrases) {
      const r = runGuardrails({
        critique: critique([feedback({ what_to_check: wt })]),
        profile: baseProfile,
      });
      expect(r.ok).toBe(false);
      expect(r.failures.map((f) => f.event)).toContain(
        GUARDRAIL_EVENTS.exampleSentence,
      );
    }
  });

  it("trips on a quoted full sentence with 5+ words and a period", () => {
    const r = runGuardrails({
      critique: critique([
        feedback({
          what_to_check:
            'Verify whether you used "I led the team to ship the migration." in your draft',
        }),
      ]),
      profile: baseProfile,
    });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.event)).toContain(
      GUARDRAIL_EVENTS.exampleSentence,
    );
  });

  it("does not trip on benign instructional text with quoted phrases", () => {
    const r = runGuardrails({
      critique: critique([
        feedback({
          what_to_check:
            "consider whether the action verb 'led' captures your contribution",
        }),
      ]),
      profile: baseProfile,
    });
    expect(r.ok).toBe(true);
  });

  it("findExampleSentence returns null on plain instructional text", () => {
    expect(findExampleSentence("verify the metric you used")).toBeNull();
  });
});

describe("guardrail 2: no hallucinated profile content", () => {
  const profileWithProject: RebuildProfileContext = {
    resume: null,
    projects: [
      {
        id: "p-1",
        userId: "u-1",
        name: "Pipeline rewrite",
        companyContext: "Acme",
        timePeriod: "2023",
        scaleDescription: null,
        teamSize: "4",
        myRole: "tech lead",
        keyDecisions: null,
        outcomesWithMetrics: "cut deploy time from 40 to 12 minutes",
        displayOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    stories: [],
  };

  it("passes when field_value appears verbatim in the source profile", () => {
    const r = runGuardrails({
      critique: critique([
        feedback({
          dimension: "profile_leverage",
          status: "needs_work",
          quoted_excerpt: "we made it faster",
          profile_reference: {
            field_path: "user_projects[id=p-1].outcomes_with_metrics",
            field_value: "cut deploy time from 40 to 12 minutes",
          },
          what_to_check:
            "if you owned that result, consider whether to mention it",
        }),
      ]),
      profile: profileWithProject,
    });
    expect(r.ok).toBe(true);
  });

  it("trips when field_value is fabricated (not in source profile)", () => {
    const r = runGuardrails({
      critique: critique([
        feedback({
          dimension: "profile_leverage",
          status: "needs_work",
          quoted_excerpt: "we made it faster",
          profile_reference: {
            field_path: "user_projects[id=p-1].outcomes_with_metrics",
            field_value: "saved the company $4M in 2024",
          },
          what_to_check:
            "if you owned that, consider whether to surface it",
        }),
      ]),
      profile: profileWithProject,
    });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.event)).toContain(
      GUARDRAIL_EVENTS.hallucinatedProfile,
    );
  });

  it("profileContains is whitespace-and-case-insensitive", () => {
    expect(
      profileContains(profileWithProject, "CUT  deploy  time  FROM 40 to 12 MINUTES"),
    ).toBe(true);
    expect(profileContains(profileWithProject, "")).toBe(false);
  });
});

describe("guardrail 3: no suggestion-without-ownership-check", () => {
  it("trips on profile_leverage what_to_check missing ownership phrasing", () => {
    const r = runGuardrails({
      critique: critique([
        feedback({
          dimension: "profile_leverage",
          status: "needs_work",
          // No "if you" / "verify" / "confirm" / etc.
          what_to_check: "Add this metric to your result.",
        }),
      ]),
      profile: baseProfile,
    });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.event)).toContain(
      GUARDRAIL_EVENTS.missingOwnershipCheck,
    );
  });

  it("trips on profile_consistency missing ownership phrasing", () => {
    const r = runGuardrails({
      critique: critique([
        feedback({
          dimension: "profile_consistency",
          status: "discrepancy",
          what_to_check: "Update your draft to match the profile.",
        }),
      ]),
      profile: baseProfile,
    });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.event)).toContain(
      GUARDRAIL_EVENTS.missingOwnershipCheck,
    );
  });

  it("does NOT require ownership phrasing on non-profile dimensions", () => {
    const r = runGuardrails({
      critique: critique([
        feedback({
          dimension: "quantification",
          status: "needs_work",
          what_to_check: "Add a specific number to your Result.",
        }),
      ]),
      profile: baseProfile,
    });
    expect(r.ok).toBe(true);
  });

  it("hasOwnershipPhrase recognizes each spec'd phrasing", () => {
    for (const p of [
      "if you",
      "whether you",
      "Did You see this",
      "can you speak to it",
      "verify the claim",
      "check whether the metric",
      "confirm the number",
    ]) {
      expect(hasOwnershipPhrase(p)).toBe(true);
    }
  });
});

describe("guardrail 4: no mismatched strong + profile_reference", () => {
  it("trips when status='strong' AND profile_reference is present", () => {
    const r = runGuardrails({
      critique: critique([
        feedback({
          dimension: "headline",
          status: "strong",
          quoted_excerpt: "headline reads well",
          profile_reference: {
            field_path: "user_profiles.career_narrative",
            field_value: "anything",
          },
          what_to_check: "this is well-structured.",
        }),
      ]),
      profile: baseProfile,
    });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.event)).toContain(
      GUARDRAIL_EVENTS.strongWithProfileRef,
    );
  });

  it("does not trip when status='strong' has no profile_reference", () => {
    const r = runGuardrails({
      critique: critique([
        feedback({
          dimension: "headline",
          status: "strong",
          what_to_check: "this is well-structured.",
        }),
      ]),
      profile: baseProfile,
    });
    expect(r.ok).toBe(true);
  });
});

describe("normalizeForVerbatim", () => {
  it("collapses whitespace and lower-cases", () => {
    expect(normalizeForVerbatim("  Hello   World\nNext\t Line ")).toBe(
      "hello world next line",
    );
  });
  it("returns empty for empty input", () => {
    expect(normalizeForVerbatim("")).toBe("");
  });
});

describe("buildFallbackCritique", () => {
  it("strips every profile_reference from the original", () => {
    const original = critique([
      feedback({
        dimension: "profile_leverage",
        status: "needs_work",
        profile_reference: {
          field_path: "x",
          field_value: "fabricated value",
        },
        what_to_check:
          "if you owned that, consider whether to surface it",
      }),
      feedback({
        dimension: "headline",
        status: "needs_work",
        what_to_check: "consider whether the headline is concrete",
      }),
    ]);
    const fb = buildFallbackCritique({
      original,
      failures: [
        {
          event: GUARDRAIL_EVENTS.hallucinatedProfile,
          reason: "test",
          dimensionIndex: 0,
        },
      ],
    });
    for (const d of fb.dimension_feedback) {
      expect(d.profile_reference).toBeUndefined();
    }
  });
});
