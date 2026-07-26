/**
 * Tests for the pass/fail forbidden-language detector. The
 * detector is the load-bearing safety net for InterviewReplay's product
 * position ("we are not a hire/no-hire prediction tool"). The
 * system prompt forbids the framings; this regex catches the
 * model when it slips and the worker retries once.
 *
 * The positive cases are the obvious slips. The negative cases
 * are the harder ones — words like "pass" can legitimately appear
 * in code-flavored quotes ("the function passes the array") and
 * in non-evaluative contexts.
 */
import { describe, expect, it } from "vitest";

import {
  containsForbiddenLanguage,
  findForbiddenLanguage,
} from "@/lib/llm";

describe("containsForbiddenLanguage — positive cases", () => {
  const SHOULD_FLAG = [
    "You would have passed the interview easily.",
    "You would not have passed the round.",
    "You will fail the system design loop without more practice.",
    "You did not pass the bar at this company.",
    "You're not a hire at this level.",
    "This is a strong hire signal.",
    "This is a leaning no-hire signal.",
    "You meet the bar for senior.",
    "You're below the bar for staff.",
    "The interviewer would have made a hire/no-hire decision",
    "You would have failed the round.",
    "Your performance exceeded the bar.",
  ];

  for (const text of SHOULD_FLAG) {
    it(`flags: "${text}"`, () => {
      expect(containsForbiddenLanguage(text)).toBe(true);
      expect(findForbiddenLanguage(text).length).toBeGreaterThan(0);
    });
  }
});

describe("containsForbiddenLanguage — negative cases", () => {
  const SHOULD_NOT_FLAG = [
    "You explained the trade-offs clearly.",
    "Try summarizing the question in your own words before answering.",
    "Your code passes an array of strings to the helper.",
    "When the function returns, the value passes through main().",
    "You should consider the failure modes of the network call.",
    "The pass-through cache simplifies the read path.",
    "You said 'um' 14 times — try a 1-second pause instead.",
    "Your STAR completeness on the conflict story was strong.",
  ];

  for (const text of SHOULD_NOT_FLAG) {
    it(`does NOT flag: "${text}"`, () => {
      expect(containsForbiddenLanguage(text)).toBe(false);
      expect(findForbiddenLanguage(text)).toHaveLength(0);
    });
  }
});

describe("findForbiddenLanguage — excerpt + pattern surfaced", () => {
  it("returns the matched excerpt for diagnostic output", () => {
    const hits = findForbiddenLanguage(
      "Looking at the whole story, you passed the round comfortably.",
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.excerpt).toContain("passed the round");
    expect(hits[0]?.pattern).toBeTruthy();
  });
});
