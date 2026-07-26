import { describe, expect, it } from "vitest";

import {
  createRebuildBodySchema,
  critiqueResponseSchema,
  listRebuildsQuerySchema,
  patchRebuildBodySchema,
} from "@/lib/rebuilds/schemas";

/**
 * Edge-validation tests for the API request body / query schemas
 * and the LLM critique response schema.
 *
 * The route handlers trust these schemas — if a value gets past
 * the schema, the route handler treats it as authoritative. So
 * the tests pin both the cap edges (a 1001-char question_text
 * MUST fail; a 1000-char question_text MUST pass) AND the
 * cross-field refinements (source_improvement_index requires
 * source_session_id).
 */

describe("createRebuildBodySchema", () => {
  it("accepts a minimal body with only question_text", () => {
    const r = createRebuildBodySchema.safeParse({
      question_text: "Tell me about a time you led a difficult conversation.",
    });
    expect(r.success).toBe(true);
  });

  it("requires question_text", () => {
    const r = createRebuildBodySchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("rejects question_text > 1000 chars", () => {
    const r = createRebuildBodySchema.safeParse({
      question_text: "x".repeat(1001),
    });
    expect(r.success).toBe(false);
  });

  it("accepts question_text == 1000 chars", () => {
    const r = createRebuildBodySchema.safeParse({
      question_text: "x".repeat(1000),
    });
    expect(r.success).toBe(true);
  });

  it("rejects source_improvement_index without source_session_id", () => {
    const r = createRebuildBodySchema.safeParse({
      question_text: "What would you do differently?",
      source_improvement_index: 1,
    });
    expect(r.success).toBe(false);
  });

  it("accepts source_improvement_index when source_session_id is present", () => {
    const r = createRebuildBodySchema.safeParse({
      question_text: "What would you do differently?",
      // Valid UUIDv4 — Zod v4's `z.uuid()` enforces the version
      // nibble (third group must start with [1-8]).
      source_session_id: "11111111-1111-4111-8111-111111111111",
      source_improvement_index: 1,
    });
    expect(r.success).toBe(true);
  });

  it("rejects an out-of-enum question_theme", () => {
    const r = createRebuildBodySchema.safeParse({
      question_text: "x",
      question_theme: "not_a_theme",
    });
    expect(r.success).toBe(false);
  });
});

describe("patchRebuildBodySchema", () => {
  it("accepts an empty body (route enforces 'must include something' separately)", () => {
    const r = patchRebuildBodySchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts null to clear a field", () => {
    const r = patchRebuildBodySchema.safeParse({ headline: null });
    expect(r.success).toBe(true);
  });

  it("rejects a 2001-char field; accepts 2000", () => {
    expect(
      patchRebuildBodySchema.safeParse({ situation: "x".repeat(2001) }).success,
    ).toBe(false);
    expect(
      patchRebuildBodySchema.safeParse({ situation: "x".repeat(2000) }).success,
    ).toBe(true);
  });

  it("rejects non-string field values", () => {
    const r = patchRebuildBodySchema.safeParse({ situation: 12 });
    expect(r.success).toBe(false);
  });
});

describe("listRebuildsQuerySchema", () => {
  it("coerces limit from string to number (URL params)", () => {
    const r = listRebuildsQuerySchema.safeParse({ limit: "25" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(25);
  });

  it("rejects limit out of range", () => {
    expect(listRebuildsQuerySchema.safeParse({ limit: "0" }).success).toBe(
      false,
    );
    expect(listRebuildsQuerySchema.safeParse({ limit: "101" }).success).toBe(
      false,
    );
  });
});

describe("critiqueResponseSchema", () => {
  function dimension(over: Record<string, unknown> = {}) {
    return {
      dimension: "headline",
      status: "needs_work",
      quoted_excerpt: "",
      what_to_check: "consider whether the headline is concrete",
      ...over,
    };
  }

  it("accepts a 5-dimension response (min)", () => {
    const r = critiqueResponseSchema.safeParse({
      overall_assessment: "ok",
      dimension_feedback: [
        dimension({ dimension: "headline" }),
        dimension({ dimension: "star_completeness" }),
        dimension({ dimension: "first_person" }),
        dimension({ dimension: "quantification" }),
        dimension({ dimension: "profile_consistency" }),
      ],
      next_step_suggestion: "pick the biggest metric",
    });
    expect(r.success).toBe(true);
  });

  it("rejects fewer than 5 dimensions", () => {
    const r = critiqueResponseSchema.safeParse({
      overall_assessment: "ok",
      dimension_feedback: [
        dimension({ dimension: "headline" }),
        dimension({ dimension: "star_completeness" }),
      ],
      next_step_suggestion: "x",
    });
    expect(r.success).toBe(false);
  });

  it("accepts 8-10 dimensions (model occasionally emits an extra well-meaning category)", () => {
    // Schema cap was bumped from 7 to 10 because Haiku
    // intermittently returns an 8th-9th dimension and rejecting
    // the whole response surfaced a generic "critique failed"
    // banner on otherwise-fine critiques. Guardrails run across
    // whatever dimensions came back; the renderer doesn't care.
    for (const count of [8, 9, 10]) {
      const dims = Array.from({ length: count }, () => dimension());
      const r = critiqueResponseSchema.safeParse({
        overall_assessment: "ok",
        dimension_feedback: dims,
        next_step_suggestion: "x",
      });
      expect(r.success).toBe(true);
    }
  });

  it("rejects more than 10 dimensions (runaway-model safety)", () => {
    const dims = Array.from({ length: 11 }, () => dimension());
    const r = critiqueResponseSchema.safeParse({
      overall_assessment: "ok",
      dimension_feedback: dims,
      next_step_suggestion: "x",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an out-of-enum dimension or status", () => {
    expect(
      critiqueResponseSchema.safeParse({
        overall_assessment: "ok",
        dimension_feedback: [
          dimension({ dimension: "not_a_dim" }),
          dimension({ dimension: "headline" }),
          dimension({ dimension: "first_person" }),
          dimension({ dimension: "quantification" }),
          dimension({ dimension: "profile_consistency" }),
        ],
        next_step_suggestion: "x",
      }).success,
    ).toBe(false);

    expect(
      critiqueResponseSchema.safeParse({
        overall_assessment: "ok",
        dimension_feedback: [
          dimension({ status: "not_a_status" }),
          dimension({ dimension: "star_completeness" }),
          dimension({ dimension: "first_person" }),
          dimension({ dimension: "quantification" }),
          dimension({ dimension: "profile_consistency" }),
        ],
        next_step_suggestion: "x",
      }).success,
    ).toBe(false);
  });

  it("accepts profile_reference when present", () => {
    const r = critiqueResponseSchema.safeParse({
      overall_assessment: "ok",
      dimension_feedback: [
        dimension({
          dimension: "profile_leverage",
          profile_reference: {
            field_path: "user_projects[id=p-1].outcomes_with_metrics",
            field_value: "saved 12 minutes per deploy",
          },
        }),
        dimension({ dimension: "headline" }),
        dimension({ dimension: "star_completeness" }),
        dimension({ dimension: "first_person" }),
        dimension({ dimension: "quantification" }),
      ],
      next_step_suggestion: "x",
    });
    expect(r.success).toBe(true);
  });

  it("coerces profile_reference: null to omitted (Haiku drift)", () => {
    // The system prompt says "omit profile_reference when not
    // applicable", but Haiku frequently emits `null` instead.
    // Plain `.optional()` rejects null and surfaced a generic
    // 502 to the user. The lenient preprocess maps null to
    // undefined so the optional branch matches.
    const r = critiqueResponseSchema.safeParse({
      overall_assessment: "ok",
      dimension_feedback: [
        dimension({ profile_reference: null }),
        dimension({ dimension: "star_completeness", profile_reference: null }),
        dimension({ dimension: "first_person" }),
        dimension({ dimension: "quantification" }),
        dimension({ dimension: "profile_consistency" }),
      ],
      next_step_suggestion: "x",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dimension_feedback[0]?.profile_reference).toBeUndefined();
    }
  });

  it("coerces profile_reference with nulled inner fields to omitted (Haiku drift)", () => {
    // 2026-06-06 staging regression: Haiku started emitting
    // `profile_reference: { field_path: null, field_value: null }`
    // on every non-citing dimension. The old preprocess only
    // caught the whole-field null case; the nested-null case
    // failed `.min(1)` validation and tripped the synthetic
    // fallback on every critique. Diagnostic warns confirmed:
    //   `[rebuild-critique] schema_validation_failed attempt=0
    //    error=dimension_feedback.0.profile_reference.field_path:
    //    Invalid input; …` (repeated for 7 dims, both attempts).
    const r = critiqueResponseSchema.safeParse({
      overall_assessment: "ok",
      dimension_feedback: [
        dimension({
          profile_reference: { field_path: null, field_value: null },
        }),
        dimension({
          dimension: "star_completeness",
          profile_reference: { field_path: "", field_value: "" },
        }),
        // Empty object — same shape, same outcome.
        dimension({ dimension: "first_person", profile_reference: {} }),
        dimension({ dimension: "quantification" }),
        dimension({ dimension: "profile_consistency" }),
      ],
      next_step_suggestion: "x",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dimension_feedback[0]?.profile_reference).toBeUndefined();
      expect(r.data.dimension_feedback[1]?.profile_reference).toBeUndefined();
      expect(r.data.dimension_feedback[2]?.profile_reference).toBeUndefined();
    }
  });

  it("still rejects half-formed profile_reference (one inner field set, other not)", () => {
    // The lenient preprocess only coerces to undefined when BOTH
    // inner fields are absent/empty. A half-formed reference is
    // a real model error worth surfacing — the retry loop can try
    // to fix it. Failing here is correct.
    const r = critiqueResponseSchema.safeParse({
      overall_assessment: "ok",
      dimension_feedback: [
        dimension({
          dimension: "profile_leverage",
          profile_reference: { field_path: "user_projects[id=x].outcomes", field_value: "" },
        }),
        dimension({ dimension: "star_completeness" }),
        dimension({ dimension: "first_person" }),
        dimension({ dimension: "quantification" }),
        dimension({ dimension: "profile_consistency" }),
      ],
      next_step_suggestion: "x",
    });
    expect(r.success).toBe(false);
  });

  it("coerces quoted_excerpt: null to empty string (Haiku drift)", () => {
    const r = critiqueResponseSchema.safeParse({
      overall_assessment: "ok",
      dimension_feedback: [
        dimension({ quoted_excerpt: null }),
        dimension({ dimension: "star_completeness" }),
        dimension({ dimension: "first_person" }),
        dimension({ dimension: "quantification" }),
        dimension({ dimension: "profile_consistency" }),
      ],
      next_step_suggestion: "x",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dimension_feedback[0]?.quoted_excerpt).toBe("");
    }
  });

  it("substitutes a placeholder for empty/null what_to_check (Haiku drift on status='strong')", () => {
    const r = critiqueResponseSchema.safeParse({
      overall_assessment: "ok",
      dimension_feedback: [
        dimension({ what_to_check: null, status: "strong" }),
        dimension({ dimension: "star_completeness", what_to_check: "" }),
        dimension({ dimension: "first_person" }),
        dimension({ dimension: "quantification" }),
        dimension({ dimension: "profile_consistency" }),
      ],
      next_step_suggestion: "x",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dimension_feedback[0]?.what_to_check.length).toBeGreaterThan(0);
      expect(r.data.dimension_feedback[1]?.what_to_check.length).toBeGreaterThan(0);
    }
  });

  it("truncates overall_assessment / next_step_suggestion overflow rather than failing", () => {
    // The original 1000 / 500 caps were tripping otherwise-fine
    // critiques where Haiku was a little chatty. Caps were bumped
    // to 2000 / 1000 and we truncate (rather than fail) past that
    // — the user-facing cost of an extra clipped sentence is much
    // lower than a "couldn't generate critique" banner.
    const r = critiqueResponseSchema.safeParse({
      overall_assessment: "x".repeat(2500),
      dimension_feedback: [
        dimension({ dimension: "headline" }),
        dimension({ dimension: "star_completeness" }),
        dimension({ dimension: "first_person" }),
        dimension({ dimension: "quantification" }),
        dimension({ dimension: "profile_consistency" }),
      ],
      next_step_suggestion: "y".repeat(1500),
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.overall_assessment.length).toBe(2000);
      expect(r.data.next_step_suggestion.length).toBe(1000);
    }
  });

  it("still rejects an explicitly empty overall_assessment / next_step_suggestion", () => {
    // Truncation is generous; emptiness is not — those fields
    // are load-bearing in the renderer and an empty critique is
    // a real failure the user should retry.
    expect(
      critiqueResponseSchema.safeParse({
        overall_assessment: "",
        dimension_feedback: [
          dimension({ dimension: "headline" }),
          dimension({ dimension: "star_completeness" }),
          dimension({ dimension: "first_person" }),
          dimension({ dimension: "quantification" }),
          dimension({ dimension: "profile_consistency" }),
        ],
        next_step_suggestion: "x",
      }).success,
    ).toBe(false);

    expect(
      critiqueResponseSchema.safeParse({
        overall_assessment: "ok",
        dimension_feedback: [
          dimension({ dimension: "headline" }),
          dimension({ dimension: "star_completeness" }),
          dimension({ dimension: "first_person" }),
          dimension({ dimension: "quantification" }),
          dimension({ dimension: "profile_consistency" }),
        ],
        next_step_suggestion: "",
      }).success,
    ).toBe(false);
  });
});
