import type { Level } from "./index";

/**
 * Per-level expectation snippets shared by every rubric file.
 * Centralized here so a future "we need a Distinguished tier"
 * change is one diff, not four.
 *
 * The snippets are deliberately short — the rubric body is the
 * detailed part; this is just the "what does ${level} look like".
 */
export const LEVEL_EXPECTATIONS: Record<Level, string> = {
  junior: [
    "Expect: solid fundamentals, will need scaffolding on novel problems,",
    "is still building intuition for trade-offs. Praise concrete reasoning,",
    "be specific about what scaffolding looks like, and avoid grading on",
    "skills typically learned in the first job (system design depth, on-call,",
    "production observability).",
  ].join(" "),
  mid: [
    "Expect: independent on familiar problems, can articulate trade-offs at",
    "a single-component scope, may need prompts to think across multiple",
    "components. Push for explicit time/space discussion and at least one",
    "alternative considered.",
  ].join(" "),
  senior: [
    "Expect: independent reasoning across components, identifies likely",
    "failure modes without prompting, weighs trade-offs against concrete",
    "operational concerns (latency budgets, SLOs, cost). Mark down vague",
    "answers ('we'd add caching') that don't pin down the cache layer or",
    "the invalidation strategy.",
  ].join(" "),
  staff: [
    "Expect: framing the problem itself, asking the right clarifying",
    "questions, weighing trade-offs against organizational concerns",
    "(team capacity, migration cost, deprecation paths). Vague",
    "decision-making is more concerning than not knowing one specific",
    "API.",
  ].join(" "),
  principal: [
    "Expect: setting the technical strategy, identifying second-order",
    "consequences, and surfacing what they'd negotiate with the",
    "interviewer's team. The interview is partly an audition for that",
    "discourse — flag where the candidate didn't engage with the",
    "interviewer's pushback as a signal independent of correctness.",
  ].join(" "),
  unsure: [
    "Level wasn't specified by the candidate. Calibrate against a",
    "mid-to-senior engineer by default; surface explicitly when an",
    "answer is much stronger or much weaker than that band so the",
    "candidate can self-locate.",
  ].join(" "),
};

export function levelHeader(level: Level): string {
  return [
    `## Level expectations for ${level}`,
    "",
    LEVEL_EXPECTATIONS[level],
  ].join("\n");
}
