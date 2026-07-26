import { describe, expect, it } from "vitest";

import type { Project, Story, StoryRebuild } from "@/lib/db/schema";
import type { RebuildProfileContext } from "@/lib/rebuilds/profile-context";
import {
  findHallucinatedSources,
  isFailureShaped,
  parseAndValidateSuggestion,
  RebuildSuggestValidationError,
} from "@/lib/rebuilds/suggest-response";
import {
  CRITIQUE_DAILY_CAP,
  RebuildSuggestRateLimitError,
  SUGGEST_DAILY_CAP,
  assertSuggestedResponseRateOk,
  countSuggestionsInLast24h,
} from "@/lib/rebuilds/critique-rate-gate";

/**
 * Unit tests for the AI-suggested-response runner.
 *
 * The runner has three layers worth pinning:
 *
 *   1. `parseAndValidateSuggestion` — the JSON / zod boundary the
 *      LLM response must clear. Same posture as
 *      `tests/rebuilds/critique-parser.test.ts`.
 *
 *   2. `findHallucinatedSources` — the verbatim-citation
 *      guardrail. Anything in `sources[].field_value` that
 *      doesn't appear in the rendered profile must come back as a
 *      hallucination. This is the load-bearing safety net.
 *
 *   3. The shared `assertSuggestedResponseRateOk` gate — same
 *      shape as the critique gate, separate counter.
 */

/* ────────────────────────────────────────────────────────────── */
/* Schema parser                                                  */
/* ────────────────────────────────────────────────────────────── */

const VALID_SUGGESTION_JSON = JSON.stringify({
  headline: "I led a 3-engineer rewrite that cut p99 latency by 40%.",
  situation:
    "At Acme in 2023 we had a checkout API with a p99 of 2.4s during peak.",
  task: "I owned the redesign as the new staff eng on the team.",
  action: "I split the path into a synchronous critical loop and async fan-out.",
  result: "p99 dropped to 1.4s in the first week and 800ms by EOQ.",
  whatIWouldChange: null,
  sources: [
    {
      field_path: "projects[id=p1].outcomes_with_metrics",
      field_value: "p99 cut from 2.4s to 800ms",
    },
  ],
  caveats: [],
});

describe("parseAndValidateSuggestion", () => {
  it("accepts a valid suggestion payload", () => {
    const out = parseAndValidateSuggestion(VALID_SUGGESTION_JSON);
    expect(out.headline.length).toBeGreaterThan(0);
    expect(out.sources.length).toBe(1);
    expect(out.whatIWouldChange).toBeNull();
  });

  it("strips a markdown fence the model sometimes adds", () => {
    const fenced = "```json\n" + VALID_SUGGESTION_JSON + "\n```";
    const out = parseAndValidateSuggestion(fenced);
    expect(out.situation.length).toBeGreaterThan(0);
  });

  it("extracts the JSON object when the model wraps it in prose", () => {
    const wrapped =
      "Here's the draft you asked for:\n\n" +
      VALID_SUGGESTION_JSON +
      "\n\nLet me know if you'd like me to expand on any section.";
    const out = parseAndValidateSuggestion(wrapped);
    expect(out.action.length).toBeGreaterThan(0);
  });

  it("coerces a missing `caveats` array to []", () => {
    const minimal = JSON.stringify({
      headline: "h",
      situation: "s",
      task: "t",
      action: "a",
      result: "r",
      whatIWouldChange: null,
      sources: [],
      caveats: null,
    });
    const out = parseAndValidateSuggestion(minimal);
    expect(out.caveats).toEqual([]);
  });

  it("throws on missing required STAR fields", () => {
    const missing = JSON.stringify({
      headline: "h",
      // situation missing
      task: "t",
      action: "a",
      result: "r",
      whatIWouldChange: null,
      sources: [],
      caveats: [],
    });
    expect(() => parseAndValidateSuggestion(missing)).toThrow(
      RebuildSuggestValidationError,
    );
  });

  it("throws on non-JSON gibberish", () => {
    expect(() => parseAndValidateSuggestion("definitely not JSON")).toThrow(
      RebuildSuggestValidationError,
    );
  });
});

/* ────────────────────────────────────────────────────────────── */
/* Verbatim-citation guardrail                                    */
/* ────────────────────────────────────────────────────────────── */

function projectFor(over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    userId: "u1",
    name: "Checkout rewrite",
    companyContext: "Acme",
    timePeriod: "Q3 2023",
    scaleDescription: "200 RPS peak",
    teamSize: "3 engineers",
    myRole: "staff eng / tech lead",
    keyDecisions: "split sync + async",
    outcomesWithMetrics: "p99 cut from 2.4s to 800ms",
    displayOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Project;
}

function storyFor(over: Partial<Story> = {}): Story {
  return {
    id: "s1",
    userId: "u1",
    theme: "ambiguous_problem",
    title: "Checkout rewrite",
    situation: "p99 was 2.4s",
    task: "Lead the redesign",
    action: "I split sync + async",
    result: "p99 dropped to 800ms",
    whatILearned: "fan-out is hard",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Story;
}

function profileWith(args: {
  projects?: Project[];
  stories?: Story[];
}): RebuildProfileContext {
  return {
    resume: null,
    projects: args.projects ?? [],
    stories: args.stories ?? [],
  };
}

describe("findHallucinatedSources", () => {
  it("returns empty when every source is verbatim in the profile", () => {
    const profile = profileWith({ projects: [projectFor()] });
    const out = findHallucinatedSources(
      [
        {
          field_path: "projects[id=p1].outcomes_with_metrics",
          field_value: "p99 cut from 2.4s to 800ms",
        },
      ],
      profile,
    );
    expect(out).toEqual([]);
  });

  it("flags a citation that's not in the profile", () => {
    const profile = profileWith({ projects: [projectFor()] });
    const out = findHallucinatedSources(
      [
        {
          field_path: "projects[id=p1].outcomes_with_metrics",
          field_value: "we cut latency by 95% (fabricated)",
        },
      ],
      profile,
    );
    expect(out.length).toBe(1);
    expect(out[0]!.field_path).toContain("outcomes_with_metrics");
  });

  it("matches case-insensitively and whitespace-tolerantly", () => {
    const profile = profileWith({
      projects: [
        projectFor({
          outcomesWithMetrics: "p99   cut\n from 2.4s\nto 800ms",
        }),
      ],
    });
    const out = findHallucinatedSources(
      [
        {
          field_path: "projects[id=p1].outcomes_with_metrics",
          field_value: "P99 cut from 2.4s to 800ms",
        },
      ],
      profile,
    );
    expect(out).toEqual([]);
  });

  it("matches against the stories slab too", () => {
    const profile = profileWith({ stories: [storyFor()] });
    const out = findHallucinatedSources(
      [
        {
          field_path: "stories[id=s1].result",
          field_value: "p99 dropped to 800ms",
        },
      ],
      profile,
    );
    expect(out).toEqual([]);
  });

  it("ignores empty field_value (no false positive trips)", () => {
    const profile = profileWith({ projects: [projectFor()] });
    const out = findHallucinatedSources(
      [{ field_path: "projects[id=p1].name", field_value: "   " }],
      profile,
    );
    expect(out).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────── */
/* `isFailureShaped`                                              */
/* ────────────────────────────────────────────────────────────── */

describe("isFailureShaped", () => {
  it("recognizes failure themes from the schema", () => {
    expect(isFailureShaped("biggest_failure")).toBe(true);
    expect(isFailureShaped("recovering_from_mistake")).toBe(true);
  });

  it("returns false for non-failure themes and missing values", () => {
    expect(isFailureShaped("leadership_conflict")).toBe(false);
    expect(isFailureShaped(null)).toBe(false);
    expect(isFailureShaped(undefined)).toBe(false);
    expect(isFailureShaped("")).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────── */
/* Rate gate (parallel to critique gate)                          */
/* ────────────────────────────────────────────────────────────── */

const NOW = new Date("2026-05-13T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function fakeRebuild(over: Partial<StoryRebuild> = {}): StoryRebuild {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    sourceSessionId: null,
    sourceImprovementIndex: null,
    questionText: "q",
    questionTheme: null,
    headline: null,
    situation: null,
    task: null,
    action: null,
    result: null,
    whatIWouldChange: null,
    aiCritiqueJson: null,
    critiqueHistory: [],
    aiSuggestedResponseJson: null,
    aiSuggestedResponseModelVersion: null,
    aiSuggestedResponseGeneratedAt: null,
    suggestedResponseHistory: [],
    promotedToStoryId: null,
    status: "in_progress",
    createdAt: new Date(NOW.getTime() - 5 * HOUR_MS),
    updatedAt: new Date(NOW.getTime() - 5 * HOUR_MS),
    ...over,
  } as StoryRebuild;
}

function entriesAt(...hoursAgo: number[]) {
  return hoursAgo.map((h) => ({
    at: new Date(NOW.getTime() - h * HOUR_MS).toISOString(),
    suggestion: { headline: "h" },
  }));
}

describe("countSuggestionsInLast24h", () => {
  it("returns 0 when no history and no current suggestion", () => {
    expect(countSuggestionsInLast24h(fakeRebuild(), NOW)).toBe(0);
  });

  it("counts only history entries inside the 24h window", () => {
    const r = fakeRebuild({
      suggestedResponseHistory: entriesAt(0.5, 5, 23, 25, 100),
    });
    expect(countSuggestionsInLast24h(r, NOW)).toBe(3);
  });

  it("counts the current suggestion when its generated-at is in window", () => {
    const r = fakeRebuild({
      aiSuggestedResponseJson: { headline: "h" },
      aiSuggestedResponseGeneratedAt: new Date(NOW.getTime() - 2 * HOUR_MS),
      suggestedResponseHistory: entriesAt(10),
    });
    expect(countSuggestionsInLast24h(r, NOW)).toBe(2);
  });

  it("does NOT count current suggestion when generated-at is outside window", () => {
    const r = fakeRebuild({
      aiSuggestedResponseJson: { headline: "h" },
      aiSuggestedResponseGeneratedAt: new Date(NOW.getTime() - 30 * HOUR_MS),
    });
    expect(countSuggestionsInLast24h(r, NOW)).toBe(0);
  });
});

describe("assertSuggestedResponseRateOk", () => {
  it("does nothing when count < cap", () => {
    const r = fakeRebuild({
      suggestedResponseHistory: entriesAt(
        ...new Array(9).fill(0).map((_, i) => i + 1),
      ),
    });
    expect(() => assertSuggestedResponseRateOk(r, NOW)).not.toThrow();
  });

  it("throws on the (cap+1)th request inside the window", () => {
    const r = fakeRebuild({
      suggestedResponseHistory: entriesAt(
        ...new Array(10).fill(0).map((_, i) => i + 1),
      ),
    });
    expect(() => assertSuggestedResponseRateOk(r, NOW)).toThrow(
      RebuildSuggestRateLimitError,
    );
  });

  it("counts current suggestion toward the cap", () => {
    const r = fakeRebuild({
      suggestedResponseHistory: entriesAt(
        ...new Array(9).fill(0).map((_, i) => i + 1),
      ),
      aiSuggestedResponseJson: { headline: "h" },
      aiSuggestedResponseGeneratedAt: new Date(NOW.getTime() - 0.25 * HOUR_MS),
    });
    expect(() => assertSuggestedResponseRateOk(r, NOW)).toThrow(
      RebuildSuggestRateLimitError,
    );
  });

  it("SUGGEST_DAILY_CAP equals CRITIQUE_DAILY_CAP (10) — pinned by spec", () => {
    expect(SUGGEST_DAILY_CAP).toBe(10);
    expect(SUGGEST_DAILY_CAP).toBe(CRITIQUE_DAILY_CAP);
  });
});
