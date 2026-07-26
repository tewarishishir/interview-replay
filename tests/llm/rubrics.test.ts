/**
 * Tests for the rubric content + the system prompt's
 * forbidden-language constraints.
 *
 * Coverage:
 *   - Every (round_type, level) combination produces a non-empty
 *     rubric body.
 *   - Each rubric explicitly forbids pass/fail framings (the
 *     load-bearing safety the spec asks us to test).
 *   - The system prompt also explicitly forbids those framings.
 */
import { describe, expect, it } from "vitest";

import {
  findForbiddenLanguage,
  rubricFor,
  SYSTEM_PROMPT,
} from "@/lib/llm";
import { interviewLevels } from "@/lib/db/schema";

const ROUND_TYPES = [
  "coding",
  "system_design",
  "behavioral",
  "other",
] as const;

describe("rubricFor — completeness", () => {
  for (const round of ROUND_TYPES) {
    for (const level of interviewLevels) {
      it(`returns a non-empty rubric for ${round} / ${level}`, () => {
        const body = rubricFor(round, level);
        expect(typeof body).toBe("string");
        expect(body.length).toBeGreaterThan(200);
        expect(body).toContain(level);
      });
    }
  }
});

describe("rubricFor — forbids pass/fail framings explicitly", () => {
  for (const round of ROUND_TYPES) {
    it(`${round} rubric explicitly forbids pass/fail and hire/no-hire`, () => {
      const body = rubricFor(round, "senior");
      // The rubric body itself must mention these forbidden
      // framings (so the model sees the rule). The forbidden-
      // language regex would flag the rubric text — that's
      // intentional, the regex is for OUTPUT, not for the
      // input prompt body.
      expect(body).toMatch(/pass\s*\/?\s*fail|fail|hire/i);
      expect(body).toMatch(/Do not state or imply a hire/i);
      expect(body).toMatch(/Do not predict whether the candidate/i);
    });
  }
});

describe("SYSTEM_PROMPT", () => {
  it("explicitly forbids pass/fail / hire-no-hire framings", () => {
    expect(SYSTEM_PROMPT).toMatch(/NEVER predict whether the candidate/i);
    expect(SYSTEM_PROMPT).toMatch(/NEVER use the words 'pass', 'fail'/i);
    expect(SYSTEM_PROMPT).toMatch(/no[-\s]hire/i);
    expect(SYSTEM_PROMPT).toMatch(/meet the bar/i);
  });

  it("instructs the model to write coaching feedback in the second person", () => {
    expect(SYSTEM_PROMPT).toMatch(/second person/i);
  });

  it("instructs the model to anchor every claim in evidence", () => {
    expect(SYSTEM_PROMPT).toMatch(/evidence/i);
    expect(SYSTEM_PROMPT).toMatch(/specific quote/i);
  });
});

describe("containsForbiddenLanguage — defensive uses of forbidden words", () => {
  // The rubric body explicitly says "Do not state or imply a hire /
  // no-hire decision" — that defensive use does trip the detector
  // (which is fine, the regex doesn't run on the rubric, only on
  // model OUTPUT). Pin the regex sensitivity here so a future tweak
  // that softens it shows up loudly.
  it("flags the literal phrase 'hire / no-hire'", () => {
    const hits = findForbiddenLanguage(
      "Do not state or imply a hire / no-hire decision.",
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  it("does NOT flag a model that LITERALLY echoes 'pass' or 'fail' in quotes", () => {
    // The model is allowed to use these words in quoted refusals
    // (e.g. 'we don't predict whether you "passed" or "failed"').
    // The regex is intentionally tuned to not trip on bare quoted
    // words, only on the trigger framings.
    const hits = findForbiddenLanguage(
      'We do not predict whether you "passed" or "failed".',
    );
    expect(hits).toEqual([]);
  });
});
