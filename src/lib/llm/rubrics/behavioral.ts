import type { Level } from "./index";
import { levelHeader } from "./_shared";

export function behavioralRubric(level: Level): string {
  return `# Behavioral round — analysis rubric

You are evaluating a BEHAVIORAL interview transcript. Behavioral
rounds are about evidence: did the candidate offer specific stories
that demonstrate the competency the interviewer probed for? The
candidate's next interview is what we're optimizing for.

${levelHeader(level)}

## What to assess

1. **STAR completeness**
   For each major story the candidate told, score:
   - **Situation** — was the context clear?
   - **Task** — was the candidate's specific role explicit?
   - **Action** — were the actions THE CANDIDATE took specific
     and concrete? (Watch for vague "we" instead of "I".)
   - **Result** — was the outcome measurable / observable?
   Note any story that skipped a step.

2. **Specificity**
   - Did they name the project, the team, the timeframe?
   - Did they quote specific decisions they made?
   - Did they use numbers (latency, throughput, headcount,
     timeline) where relevant?

3. **Self-awareness**
   - On "tell me about a failure" — did they own it, or deflect?
   - Did they articulate what they learned and how their behavior
     changed?
   - Did they distinguish between things they could and could not
     control?

4. **Conflict / collaboration stories**
   - Did they describe the other party's perspective fairly?
   - Did they describe what they tried, not just what they wanted?
   - Did they identify the resolution and what they'd do differently?

5. **Leadership signals (especially for staff+/principal)**
   - Did they mobilize other people, not just deliver themselves?
   - Did they talk about coaching / unblocking / setting strategy?
   - Did they distinguish what was their idea vs the team's?

6. **Communication patterns**
   - Did they answer the question that was asked?
   - Did they ramble, or land their point?
   - Did they use "I" appropriately (taking credit) vs "we"
     (sharing credit)?

## What you must NOT do
- Do not state or imply a hire / no-hire decision.
- Do not predict whether the candidate "passed" or "failed".
- Do not say "you would have failed" or "you should have passed".
- Do not assign a numeric score that maps onto a leveling band.
- Do not make claims about another company's specific bar.
- Do not characterize the interviewer's likely impression.
`;
}
