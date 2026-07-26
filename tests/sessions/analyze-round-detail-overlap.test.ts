/**
 * Tests for the round-type detail diagnostic scorecard guardrails:
 *
 *   1. round_type_detail contains measurements, not prescriptions
 *      — "you should", "try to", "could improve" are forbidden
 *   2. Numeric distributions appear where dimensions are countable
 *      — structural patterns like "N/N", "N specific", "N failure modes"
 *   3. Overlap with Strengths is < 0.25
 *   4. Overlap with Improvements is < 0.25
 *
 * These are pure-function tests. No DB, no job runner, no LLM provider.
 *
 * The overlap and prescriptive-language checks mirror what
 * `analyze-session.ts` runs at runtime after LLM generation.
 */
import { describe, expect, it } from "vitest";

import { detectOverlap } from "@/job-runner/functions/analyze-session";

// ─── Helpers ──────────────────────────────────────────────────────

const PRESCRIPTIVE_PATTERN = /\byou should\b|\btry to\b|\bcould improve\b/i;

function hasPrescriptiveLanguage(text: string): boolean {
  return PRESCRIPTIVE_PATTERN.test(text);
}

function extractRoundDetailText(
  roundSpecific: Record<string, string>,
): string {
  return Object.entries(roundSpecific)
    .filter(([key]) => key !== "kind")
    .map(([, val]) => val)
    .join(" ");
}

// ─── Behavioral round-detail measurement fixtures ─────────────────

const BEHAVIORAL_ROUND_DETAIL_MEASUREMENT = {
  kind: "behavioral",
  starCompleteness:
    "Across your 4 major stories, Situation appeared in 4/4, Task in 4/4, Action in 4/4, Result in 1/4. " +
    "The Redshift migration story, the analytics trust rebuild, and the PIP focus-plan story each closed " +
    "without a quantified outcome. Only the bar-raiser adaptation story stated a concrete metric.",
  specificity:
    "You named 3 specific companies, 5 specific tools/products, 2 specific time periods, and 1 specific " +
    "outcome metric. Specificity on people and tools was high; specificity on quantified outcomes was low.",
  selfAwareness:
    "Across your 4 stories, 2 included explicit self-critique or a named learning. The analytics trust rebuild " +
    "showed genuine self-reflection (named the breakdown in communication as your own). The PIP story attributed " +
    "the underperformance entirely to the report without naming what you would do differently at the start.",
  leadershipSignals:
    "You showed these leadership signals: talent development (Redshift engineer promotion), crisis management " +
    "(analytics trust rebuild), performance management (PIP structure). You did NOT show these signal types: " +
    "cross-functional influence beyond your team, setting strategic technical direction, org-level conflict navigation.",
};

const BEHAVIORAL_STRENGTHS_TEXT =
  "Concrete PIP mechanics when asked about underperformance you walked through a six-month focus-plan structure " +
  "with weekly check-ins and a measurable exit criterion that showed you manage the process not the person. " +
  "Self-awareness on the conflict story the analytics trust rebuild showed genuine ownership of the failure.";

const BEHAVIORAL_IMPROVEMENTS_TEXT =
  "Quantify your results every story is missing a number the Redshift migration story needs a latency figure " +
  "the PIP story needs a timeline and the bar-raiser story needs a hire rate. Practice ending each story with " +
  "the metric before your next interview. Close every story with one quantified outcome.";

// ─── Coding round-detail measurement fixture ──────────────────────

const CODING_ROUND_DETAIL_MEASUREMENT = {
  kind: "coding",
  problemFraming:
    "Problem 1: You asked 3 clarifying questions before coding (input type, output format, duplicate handling). " +
    "You did not ask about edge cases for empty arrays or integer overflow. " +
    "Problem 2: You asked 1 clarifying question (expected time complexity). You did not ask about space constraints.",
  solutionExploration:
    "Problem 1: You proposed 2 approaches before coding (brute force O(n²) then optimized hash-map O(n)). " +
    "Problem 2: You proposed 1 approach before coding. Trade-off articulation present on 1/2 problems.",
  implementationHygiene:
    "You used helper functions correctly on both problems. You wrote logical-step comments before code on " +
    "Problem 1 but not Problem 2. Narration during coding: narrated roughly 70% of coding time on Problem 1, " +
    "roughly 20% on Problem 2 (silent for the bulk of the implementation).",
  verification:
    "Problem 1: You traced 2 concrete examples through your solution (happy path + duplicate input). " +
    "Problem 2: You traced 0 concrete examples. You verified output matched expected on 1/2 problems.",
  recoveryFromFeedback:
    "The interviewer pushed back 2 times. You acknowledged and pivoted correctly on 1/2. " +
    "The space-complexity pushback was your cleanest recovery (acknowledged immediately, rewrote the solution). " +
    "The edge-case pushback showed roughly 30 seconds of confusion before you identified the fix.",
};

const CODING_STRENGTHS_TEXT =
  "Strong approach articulation on the first problem you named the brute force then explained why the hash map " +
  "was better before writing a line. Clear solution exploration before committing to code.";

const CODING_IMPROVEMENTS_TEXT =
  "Narrate while coding on Problem 2 you went silent for the entire implementation and the interviewer had no " +
  "visibility into your reasoning. Practice thinking out loud even when concentrating on syntax.";

// ─── System design round-detail measurement fixture ───────────────

const SYSTEM_DESIGN_ROUND_DETAIL_MEASUREMENT = {
  kind: "system_design",
  requirementsGathering:
    "You asked about: vendor count, invoice volume per day, latency requirements, and data freshness SLA. " +
    "You did NOT ask about: read/write ratio, SLO targets (availability/error budget), growth rate over 3 years, " +
    "or multi-region requirements.",
  highLevelDesign:
    "You proposed 4 components: ingestion service, processing queue, storage layer, and query API. " +
    "Connections described: ingestion → queue → storage, query API reads from storage. " +
    "Components you did not address in the high-level design: serving cache, schema evolution strategy.",
  deepDives:
    "You went deep on: storage layer (partitioning strategy, retention policy), processing queue (backpressure handling). " +
    "You stayed shallow on: serving layer (no discussion of query patterns or index design), schema contracts (mentioned but not designed).",
  tradeOffsAndFailureModes:
    "You self-surfaced 2 failure modes: queue overflow under burst load, and storage hot partitions. " +
    "You needed interviewer prompts for 3 failure modes: ingestion idempotency, cross-region replication lag, " +
    "and schema migration rollback. Total failure mode coverage: 5/7 expected at senior level.",
  scalingStory:
    "You discussed cluster resource isolation with a concrete threshold (10k vendors triggers dedicated processing pool). " +
    "You did not address the 10x growth path, sharding strategy, or distributed query engine options.",
};

const SYSTEM_DESIGN_STRENGTHS_TEXT =
  "Strong storage layer depth you designed the partitioning strategy unprompted and named a concrete retention policy. " +
  "Queue backpressure handling showed solid distributed systems intuition.";

const SYSTEM_DESIGN_IMPROVEMENTS_TEXT =
  "Complete the serving layer the query API was named but never designed. Add index design and query pattern " +
  "discussion to every system design. Self-surface failure modes before the interviewer prompts you.";

// ─── Tests: prescriptive language detection ───────────────────────

describe("round-detail prescriptive language detection", () => {
  it("behavioral round detail (measurement) contains no prescriptive language", () => {
    const text = extractRoundDetailText(BEHAVIORAL_ROUND_DETAIL_MEASUREMENT);
    expect(hasPrescriptiveLanguage(text)).toBe(false);
  });

  it("coding round detail (measurement) contains no prescriptive language", () => {
    const text = extractRoundDetailText(CODING_ROUND_DETAIL_MEASUREMENT);
    expect(hasPrescriptiveLanguage(text)).toBe(false);
  });

  it("system design round detail (measurement) contains no prescriptive language", () => {
    const text = extractRoundDetailText(SYSTEM_DESIGN_ROUND_DETAIL_MEASUREMENT);
    expect(hasPrescriptiveLanguage(text)).toBe(false);
  });

  it("detects 'you should' as prescriptive", () => {
    expect(hasPrescriptiveLanguage("You should quantify your results.")).toBe(true);
  });

  it("detects 'try to' as prescriptive", () => {
    expect(hasPrescriptiveLanguage("Try to narrate while coding.")).toBe(true);
  });

  it("detects 'could improve' as prescriptive", () => {
    expect(hasPrescriptiveLanguage("Your verification could improve significantly.")).toBe(true);
  });

  it("is case-insensitive for prescriptive detection", () => {
    expect(hasPrescriptiveLanguage("YOU SHOULD ask more clarifying questions.")).toBe(true);
    expect(hasPrescriptiveLanguage("TRY TO self-surface failure modes.")).toBe(true);
  });

  it("does not flag measurement language as prescriptive", () => {
    expect(hasPrescriptiveLanguage("Across your 4 stories, Situation appeared in 4/4.")).toBe(false);
    expect(hasPrescriptiveLanguage("You named 3 specific companies and 5 tools.")).toBe(false);
    expect(hasPrescriptiveLanguage("You self-surfaced 2 failure modes.")).toBe(false);
  });
});

// ─── Tests: numeric distribution patterns ─────────────────────────

describe("round-detail contains numeric distributions where dimensions are countable", () => {
  it("behavioral starCompleteness contains N/N distribution pattern", () => {
    const { starCompleteness } = BEHAVIORAL_ROUND_DETAIL_MEASUREMENT;
    expect(starCompleteness).toMatch(/\d+\/\d+/);
  });

  it("behavioral specificity contains numeric counts", () => {
    const { specificity } = BEHAVIORAL_ROUND_DETAIL_MEASUREMENT;
    expect(specificity).toMatch(/\d+ specific/);
  });

  it("coding verification contains N/N ratio", () => {
    const { verification } = CODING_ROUND_DETAIL_MEASUREMENT;
    expect(verification).toMatch(/\d+\/\d+/);
  });

  it("coding solutionExploration contains trade-off articulation N/N ratio", () => {
    const { solutionExploration } = CODING_ROUND_DETAIL_MEASUREMENT;
    expect(solutionExploration).toMatch(/\d+\/\d+/);
  });

  it("system design tradeOffsAndFailureModes contains self-surfaced count", () => {
    const { tradeOffsAndFailureModes } = SYSTEM_DESIGN_ROUND_DETAIL_MEASUREMENT;
    expect(tradeOffsAndFailureModes).toMatch(/\d+ failure modes/i);
  });
});

// ─── Tests: overlap with Strengths < 0.25 ─────────────────────────

describe("round-detail overlap with Strengths is < 0.25", () => {
  it("behavioral round detail does not overlap behavioral strengths", () => {
    const roundDetailText = extractRoundDetailText(
      BEHAVIORAL_ROUND_DETAIL_MEASUREMENT,
    );
    const overlap = detectOverlap(BEHAVIORAL_STRENGTHS_TEXT, roundDetailText);
    expect(overlap).toBeLessThan(0.25);
  });

  it("coding round detail does not overlap coding strengths", () => {
    const roundDetailText = extractRoundDetailText(CODING_ROUND_DETAIL_MEASUREMENT);
    const overlap = detectOverlap(CODING_STRENGTHS_TEXT, roundDetailText);
    expect(overlap).toBeLessThan(0.25);
  });

  it("system design round detail does not overlap system design strengths", () => {
    const roundDetailText = extractRoundDetailText(
      SYSTEM_DESIGN_ROUND_DETAIL_MEASUREMENT,
    );
    const overlap = detectOverlap(SYSTEM_DESIGN_STRENGTHS_TEXT, roundDetailText);
    expect(overlap).toBeLessThan(0.25);
  });
});

// ─── Tests: overlap with Improvements < 0.25 ─────────────────────

describe("round-detail overlap with Improvements is < 0.25", () => {
  it("behavioral round detail does not overlap behavioral improvements", () => {
    const roundDetailText = extractRoundDetailText(
      BEHAVIORAL_ROUND_DETAIL_MEASUREMENT,
    );
    const overlap = detectOverlap(BEHAVIORAL_IMPROVEMENTS_TEXT, roundDetailText);
    expect(overlap).toBeLessThan(0.25);
  });

  it("coding round detail does not overlap coding improvements", () => {
    const roundDetailText = extractRoundDetailText(CODING_ROUND_DETAIL_MEASUREMENT);
    const overlap = detectOverlap(CODING_IMPROVEMENTS_TEXT, roundDetailText);
    expect(overlap).toBeLessThan(0.25);
  });

  it("system design round detail does not overlap system design improvements", () => {
    const roundDetailText = extractRoundDetailText(
      SYSTEM_DESIGN_ROUND_DETAIL_MEASUREMENT,
    );
    const overlap = detectOverlap(SYSTEM_DESIGN_IMPROVEMENTS_TEXT, roundDetailText);
    expect(overlap).toBeLessThan(0.25);
  });
});

// ─── Counter-examples: critiques DO overlap ───────────────────────

describe("critique-style round detail DOES overlap with Strengths/Improvements (counter-examples)", () => {
  it("a round detail that restates improvements triggers > 0.25 overlap", () => {
    const critiqueThatDuplicatesImprovements = {
      kind: "behavioral",
      starCompleteness:
        "Every story is missing a number. The Redshift migration story needs a latency figure, the PIP story " +
        "needs a timeline, and the bar-raiser story needs a hire rate. Quantify your results before your next interview.",
      specificity: "Your specificity on quantified outcomes was weak.",
      selfAwareness: "You were mostly self-aware.",
      leadershipSignals: "Leadership signals were present.",
    };
    const roundDetailText = extractRoundDetailText(critiqueThatDuplicatesImprovements);
    const overlap = detectOverlap(BEHAVIORAL_IMPROVEMENTS_TEXT, roundDetailText);
    // The critique directly restates the improvements text — overlap should be high
    expect(overlap).toBeGreaterThan(0.25);
  });
});
