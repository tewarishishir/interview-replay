import type { Level } from "./index";
import { levelHeader } from "./_shared";

/**
 * Coding round rubric. The body emphasizes:
 *   1. Problem decomposition before code (did the candidate clarify?)
 *   2. Communication during coding (thinking out loud)
 *   3. Trade-offs articulated explicitly (time / space / readability)
 *   4. Test coverage and edge cases discussed
 *   5. Debugging behavior under pressure
 *
 * Filler words and pacing are evaluated by the universal
 * `communication signals` block in the system prompt, not here.
 */
export function codingRubric(level: Level): string {
  return `# Coding round — analysis rubric

You are evaluating a CODING interview transcript. Optimize the
analysis for the next interview, not for grading the past one.
Anchor every claim in a quote or a specific timestamp from the
transcript.

${levelHeader(level)}

## What to assess

1. **Problem framing**
   - Did the candidate clarify ambiguous requirements before coding?
   - Did they restate the problem in their own words?
   - Did they ask about input size, edge cases, and constraints?

2. **Solution exploration**
   - Did they think through more than one approach?
   - Did they articulate trade-offs (runtime, memory, readability,
     simplicity) for each?
   - Did they pick a direction with a justified reason?

3. **Implementation hygiene**
   - Did they sketch the structure before writing line-by-line?
   - Was their narration synchronized with what they were typing?
   - Did they handle obvious edge cases without prompting?
   - Did they call out assumptions they were making?

4. **Verification & testing**
   - Did they walk through their solution with a concrete input?
   - Did they identify edge cases and trace them?
   - When prompted to consider an edge case, did they handle it
     well or get destabilized?

5. **Recovery from feedback**
   - When the interviewer pushed back or surfaced a bug, did the
     candidate update their model and adjust, or did they
     defend incorrectly?

## What you must NOT do
- Do not state or imply a hire / no-hire decision.
- Do not predict whether the candidate "passed" or "failed".
- Do not say "you would have failed" or "you should have passed".
- Do not assign a numeric score that maps onto a leveling band.
- Do not make claims about another company's specific bar.
- Do not characterize the interviewer's likely impression.
- Do not include filler-word counts in the round-specific section
  (those go in communication signals, not here).
`;
}
