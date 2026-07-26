/**
 * Unit tests for `hasFormulaicOpening` — the first-sentence guard
 * that detects templated aiRead openers and triggers a retry.
 *
 * These are pure functions: no DB, no job runner, no LLM provider.
 *
 * The load-bearing contracts:
 *   - Returns true for every banned opener pattern ('Your X',
 *     'You demonstrated', 'You showed', 'This was a', etc.)
 *   - Returns false for all five alternative opening structures
 *     (A–E) from the system prompt.
 *   - Only the FIRST sentence is evaluated — a formulaic follow-on
 *     sentence must not trigger the check.
 */
import { describe, expect, it } from "vitest";

import { hasFormulaicOpening } from "@/job-runner/functions/analyze-session";

// ─── Banned patterns (must return true) ───────────────────────────

describe("hasFormulaicOpening — banned openers", () => {
  it('returns true for "Your interview showed..."', () => {
    expect(
      hasFormulaicOpening(
        "Your interview showed genuine technical depth, but the narration gap cost you.",
      ),
    ).toBe(true);
  });

  it('returns true for "You demonstrated genuine..."', () => {
    expect(
      hasFormulaicOpening(
        "You demonstrated genuine command of distributed systems fundamentals.",
      ),
    ).toBe(true);
  });

  it('returns true for "This was a..."', () => {
    expect(
      hasFormulaicOpening(
        "This was a strong behavioral round with one critical gap in ownership framing.",
      ),
    ).toBe(true);
  });

  it('returns true for "You showed..."', () => {
    expect(
      hasFormulaicOpening(
        "You showed real depth in the system-design section but stumbled at the serving layer.",
      ),
    ).toBe(true);
  });

  it('returns true for "You came across as..."', () => {
    expect(
      hasFormulaicOpening("You came across as well-prepared but under-quantified."),
    ).toBe(true);
  });

  it('returns true for "You delivered..."', () => {
    expect(
      hasFormulaicOpening(
        "You delivered a technically correct solution without narrating your reasoning.",
      ),
    ).toBe(true);
  });

  it('returns true for "You gave..."', () => {
    expect(
      hasFormulaicOpening("You gave a solid answer on the failure story."),
    ).toBe(true);
  });

  it('returns true for "This interview..."', () => {
    expect(
      hasFormulaicOpening(
        "This interview landed solidly in the 'building' band with one fixable gap.",
      ),
    ).toBe(true);
  });

  it('returns true for "This session..."', () => {
    expect(
      hasFormulaicOpening("This session showed uneven STAR completeness across your stories."),
    ).toBe(true);
  });

  it('returns true for "Your SQL knowledge..."', () => {
    expect(
      hasFormulaicOpening(
        "Your SQL knowledge is strong, but your narration while coding is where the gap lives.",
      ),
    ).toBe(true);
  });

  it('returns true for "Your technical depth..."', () => {
    expect(
      hasFormulaicOpening("Your technical depth is evident but your trade-off framing needs work."),
    ).toBe(true);
  });
});

// ─── Allowed openers (must return false) ──────────────────────────

describe("hasFormulaicOpening — allowed openers (structures A–E)", () => {
  it("returns false for Structure A — lead with the action", () => {
    expect(
      hasFormulaicOpening(
        "Before your next interview, write one quantified result for every story in your bank. That single shift is what separates 'solid contributor' from 'owns outcomes' at the L5 level.",
      ),
    ).toBe(false);
  });

  it("returns false for Structure B — lead with a specific moment", () => {
    expect(
      hasFormulaicOpening(
        "The clearest moment of this interview was when you solved the subarray problem correctly but went silent for four minutes — everything else in the round sat at the edges of that gap.",
      ),
    ).toBe(false);
  });

  it("returns false for Structure C — lead with the gap directly", () => {
    expect(
      hasFormulaicOpening(
        "The thing that kept this from being a clean yes was the missing Result on every behavioral story. Fix that one pattern and the strong substance you already have lands completely differently.",
      ),
    ).toBe(false);
  });

  it("returns false for Structure D — lead with a contrast", () => {
    expect(
      hasFormulaicOpening(
        "Two answers did opposite work for you in this session: the Stripe migration story showed exactly what L5 sounds like, and the conflict resolution story showed exactly what someone still arriving at that level sounds like.",
      ),
    ).toBe(false);
  });

  it("returns false for Structure E — lead with a quantified pattern", () => {
    expect(
      hasFormulaicOpening(
        "Across 18 questions, one pattern decided this interview: owning your decisions with 'I' instead of 'we'. When you avoided it, your stories landed with authority. When you fell into it, the credit diffused.",
      ),
    ).toBe(false);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────

describe("hasFormulaicOpening — edge cases", () => {
  it("only checks the first sentence, not later sentences", () => {
    // Opening is fine; a later sentence uses a banned pattern — should be false.
    expect(
      hasFormulaicOpening(
        "Before your next interview, practice narrating out loud as you code. Your technical depth was not the issue here.",
      ),
    ).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(hasFormulaicOpening("")).toBe(false);
  });

  it("is case-insensitive for banned patterns", () => {
    expect(hasFormulaicOpening("YOUR interview showed strong fundamentals.")).toBe(true);
    expect(hasFormulaicOpening("you DEMONSTRATED good problem framing.")).toBe(true);
  });
});
