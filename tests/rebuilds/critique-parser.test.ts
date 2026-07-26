import { describe, expect, it } from "vitest";

import {
  parseAndValidate,
  RebuildCritiqueValidationError,
} from "@/lib/rebuilds/critique";

/**
 * Unit tests for `parseAndValidate` — the pure parser that
 * `runCritique` uses to validate LLM provider's response. Pinning
 * each lenient defense layer here so a future "tighten the
 * schema" change can't silently re-introduce the failure modes
 * that surfaced as a generic "We couldn't generate a critique"
 * banner.
 *
 * Defense layers:
 *
 *   1. Strip Markdown ```json fence (existing behavior).
 *   2. Extract the outermost JSON object from prose around it
 *      ("Here's the critique:\n\n{...}\n\nHope that helps!").
 *   3. Coerce common Haiku drift (`null` for optional fields,
 *      empty `what_to_check`) to schema-compliant values.
 *   4. Truncate over-long prose fields rather than failing.
 */

const dim = (over: Record<string, unknown> = {}) => ({
  dimension: "headline",
  status: "needs_work",
  quoted_excerpt: "",
  what_to_check: "consider whether the headline is concrete",
  ...over,
});

const fivePassingDimensions = [
  dim({ dimension: "headline" }),
  dim({ dimension: "star_completeness" }),
  dim({ dimension: "first_person" }),
  dim({ dimension: "quantification" }),
  dim({ dimension: "profile_consistency" }),
];

const baseCritique = {
  overall_assessment: "Solid draft.",
  dimension_feedback: fivePassingDimensions,
  next_step_suggestion: "Tighten the result.",
};

describe("parseAndValidate — clean parse", () => {
  it("returns a validated CritiqueResponse for a clean JSON object", () => {
    const out = parseAndValidate(JSON.stringify(baseCritique));
    expect(out.overall_assessment).toBe("Solid draft.");
    expect(out.dimension_feedback).toHaveLength(5);
    expect(out.next_step_suggestion).toBe("Tighten the result.");
  });
});

describe("parseAndValidate — Markdown fence stripping", () => {
  it("strips ```json ... ``` fence", () => {
    const raw = "```json\n" + JSON.stringify(baseCritique) + "\n```";
    const out = parseAndValidate(raw);
    expect(out.overall_assessment).toBe("Solid draft.");
  });

  it("strips bare ``` ... ``` fence", () => {
    const raw = "```\n" + JSON.stringify(baseCritique) + "\n```";
    const out = parseAndValidate(raw);
    expect(out.overall_assessment).toBe("Solid draft.");
  });
});

describe("parseAndValidate — JSON extraction from prose", () => {
  it("extracts JSON when the model adds a leading sentence", () => {
    const raw =
      "Here is the critique you asked for:\n\n" + JSON.stringify(baseCritique);
    const out = parseAndValidate(raw);
    expect(out.overall_assessment).toBe("Solid draft.");
  });

  it("extracts JSON when the model adds a trailing sentence", () => {
    const raw =
      JSON.stringify(baseCritique) +
      "\n\nLet me know if you'd like me to expand on any dimension!";
    const out = parseAndValidate(raw);
    expect(out.overall_assessment).toBe("Solid draft.");
  });

  it("extracts JSON when the model wraps it in prose on both sides", () => {
    const raw =
      "Sure! Here's my critique:\n\n" +
      JSON.stringify(baseCritique) +
      "\n\nHappy to revise.";
    const out = parseAndValidate(raw);
    expect(out.overall_assessment).toBe("Solid draft.");
  });

  it("throws on non-JSON garbage", () => {
    expect(() => parseAndValidate("not even close to JSON")).toThrow(
      RebuildCritiqueValidationError,
    );
  });
});

describe("parseAndValidate — Haiku drift coercion", () => {
  it("accepts profile_reference: null for dimensions that don't reference the profile", () => {
    const out = parseAndValidate(
      JSON.stringify({
        ...baseCritique,
        dimension_feedback: [
          dim({ profile_reference: null }),
          dim({ dimension: "star_completeness", profile_reference: null }),
          dim({ dimension: "first_person", profile_reference: null }),
          dim({ dimension: "quantification", profile_reference: null }),
          dim({ dimension: "profile_consistency", profile_reference: null }),
        ],
      }),
    );
    for (const d of out.dimension_feedback) {
      expect(d.profile_reference).toBeUndefined();
    }
  });

  it("accepts quoted_excerpt: null and coerces to empty string", () => {
    const out = parseAndValidate(
      JSON.stringify({
        ...baseCritique,
        dimension_feedback: [
          dim({ quoted_excerpt: null }),
          ...fivePassingDimensions.slice(1),
        ],
      }),
    );
    expect(out.dimension_feedback[0]?.quoted_excerpt).toBe("");
  });

  it("substitutes a placeholder for empty what_to_check", () => {
    const out = parseAndValidate(
      JSON.stringify({
        ...baseCritique,
        dimension_feedback: [
          dim({ what_to_check: "" }),
          ...fivePassingDimensions.slice(1),
        ],
      }),
    );
    expect(out.dimension_feedback[0]?.what_to_check.length).toBeGreaterThan(0);
  });

  it("accepts up to 10 dimensions (Haiku occasionally adds an extra category)", () => {
    const out = parseAndValidate(
      JSON.stringify({
        ...baseCritique,
        dimension_feedback: Array.from({ length: 9 }, () => dim()),
      }),
    );
    expect(out.dimension_feedback).toHaveLength(9);
  });

  it("truncates an over-long overall_assessment rather than failing", () => {
    const out = parseAndValidate(
      JSON.stringify({
        ...baseCritique,
        overall_assessment: "x".repeat(2500),
      }),
    );
    expect(out.overall_assessment.length).toBe(2000);
  });
});
