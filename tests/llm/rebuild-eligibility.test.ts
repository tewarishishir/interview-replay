/**
 * Tests for the per-improvement rebuild-eligibility helpers used by
 * `report-view.tsx` to decide where to render the inline "Rebuild a
 * story for this →" button (and how many to count in the orientation
 * note above the Improvements section).
 *
 * The decision itself is the model's — these helpers just read the
 * `improvement.rebuildEligible` flag the analyzer set during the
 * report-generation prompt. The tests pin two contracts:
 *
 *   1. Strict-equality semantics so a future schema relaxation that
 *      lets the field be `null` or an unknown value can never
 *      silently flip to "show the button". Option A in the rebuild-
 *      refactor spec is "no button on legacy reports"; the strictness
 *      here is the load-bearing defense.
 *
 *   2. The orientation note's count helper agrees with the per-card
 *      `isRebuildEligible` decision so a report can never claim
 *      "3 of 5" while the cards render only 2 buttons.
 */
import { describe, expect, it } from "vitest";

import {
  countRebuildEligible,
  isRebuildEligible,
  orientationNoteCopy,
} from "@/lib/llm/rebuild-eligibility";
import type { Improvement } from "@/lib/llm";

const baseImprovement = (
  overrides: Partial<Improvement> = {},
): Improvement => ({
  heading: "Tighten the Result on your migration story",
  detail: "You wrapped without naming the metric you moved.",
  action:
    "Add the before/after number for the metric you owned in your STAR Result.",
  evidence: [],
  rebuildEligible: false,
  ...overrides,
});

describe("isRebuildEligible — per-improvement gate for the inline button", () => {
  it("returns true when the model marked the improvement eligible", () => {
    expect(isRebuildEligible(baseImprovement({ rebuildEligible: true }))).toBe(
      true,
    );
  });

  it("returns false when the model marked the improvement ineligible", () => {
    expect(
      isRebuildEligible(baseImprovement({ rebuildEligible: false })),
    ).toBe(false);
  });

  it("returns false on a legacy improvement with no rebuildEligible field (Option A fallback)", () => {
    // Legacy reports persisted before the field was introduced parse
    // through the schema with the flag DEFAULTED to false (see
    // `improvementSchema` in `lib/llm/schema.ts`). We assert the
    // helper agrees so the migration story holds end-to-end:
    // legacy reports surface no inline button, full stop.
    const legacy = baseImprovement();
    // Force the absent-field shape the schema would produce on
    // legacy data, mimicking what `reportSchema.parse(legacyJson)`
    // would yield. The cast is the only place in the suite where
    // we sidestep the type so the absence path is exercised.
    delete (legacy as Partial<Improvement>).rebuildEligible;
    expect(
      isRebuildEligible(legacy as unknown as Improvement),
    ).toBe(false);
  });

  it("uses STRICT equality so a future schema relaxation can't silently flip it on", () => {
    // Defense-in-depth: if a future change ever lets the field be
    // `null` (e.g. "we don't know yet"), the helper MUST treat that
    // as "no button" rather than "show button". A wrong button is
    // worse than no button — see the rebuild-refactor spec.
    const ambiguous = baseImprovement();
    (ambiguous as { rebuildEligible: unknown }).rebuildEligible = null;
    expect(isRebuildEligible(ambiguous)).toBe(false);

    (ambiguous as { rebuildEligible: unknown }).rebuildEligible = "yes";
    expect(isRebuildEligible(ambiguous)).toBe(false);

    (ambiguous as { rebuildEligible: unknown }).rebuildEligible = 1;
    expect(isRebuildEligible(ambiguous)).toBe(false);
  });
});

describe("countRebuildEligible — drives the Improvements orientation note", () => {
  it("returns {0, 0} for an empty list", () => {
    expect(countRebuildEligible([])).toEqual({ eligible: 0, total: 0 });
  });

  it("returns {0, n} when no improvement is eligible (note must NOT render)", () => {
    // The orientation note is gated on `eligible > 0` in the view —
    // pinning the count here is the upstream half of the contract.
    const out = countRebuildEligible([
      baseImprovement({ rebuildEligible: false }),
      baseImprovement({ rebuildEligible: false }),
      baseImprovement({ rebuildEligible: false }),
    ]);
    expect(out).toEqual({ eligible: 0, total: 3 });
  });

  it("counts only true entries, preserving the total", () => {
    const out = countRebuildEligible([
      baseImprovement({ rebuildEligible: true }),
      baseImprovement({ rebuildEligible: false }),
      baseImprovement({ rebuildEligible: true }),
      baseImprovement({ rebuildEligible: false }),
      baseImprovement({ rebuildEligible: true }),
    ]);
    expect(out).toEqual({ eligible: 3, total: 5 });
  });

  it("never over-counts on legacy improvements without the field", () => {
    const legacy = baseImprovement();
    delete (legacy as Partial<Improvement>).rebuildEligible;
    const out = countRebuildEligible([
      baseImprovement({ rebuildEligible: true }),
      legacy as unknown as Improvement,
      baseImprovement({ rebuildEligible: true }),
    ]);
    // Legacy entry is treated as ineligible — the count must reflect
    // exactly the buttons the per-card helper will render.
    expect(out).toEqual({ eligible: 2, total: 3 });
  });
});

describe("orientationNoteCopy — grammar contract for the Improvements note", () => {
  // The note is the first thing the candidate sees above the
  // Improvements list. A grammar miss here ("1 improvements
  // below…") visibly erodes trust before they've read a single
  // recommendation. The copy contract is locked in here so a
  // future tweak can't regress on the singular / all-eligible
  // cases.
  //
  // The copy helper is only ever called when `eligible > 0` (the
  // view gates on it), so the zero-eligible case isn't covered —
  // the note simply doesn't render.

  it("singular improvement: uses 'The improvement below…' (no '1 of 1')", () => {
    expect(orientationNoteCopy({ eligible: 1, total: 1 })).toBe(
      "The improvement below can be turned into a structured rebuild — look for the rebuild button.",
    );
  });

  it("all-eligible plural: uses 'All N improvements below…' (no '5 of 5')", () => {
    expect(orientationNoteCopy({ eligible: 5, total: 5 })).toBe(
      "All 5 improvements below can be turned into structured rebuilds — look for the rebuild button.",
    );
  });

  it("mixed: uses '{n} of {total} improvements …'", () => {
    expect(orientationNoteCopy({ eligible: 2, total: 5 })).toBe(
      "2 of 5 improvements below can be turned into structured rebuilds — look for the rebuild button.",
    );
  });

  it("eligible > 1, total === 2: still reads 'X of 2 improvements'", () => {
    // Edge of the plural range — make sure 'improvements' (plural)
    // is preserved when total >= 2 even on a small list.
    expect(orientationNoteCopy({ eligible: 1, total: 2 })).toBe(
      "1 of 2 improvements below can be turned into structured rebuilds — look for the rebuild button.",
    );
  });
});
