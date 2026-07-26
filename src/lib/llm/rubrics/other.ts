import type { Level } from "./index";
import { levelHeader } from "./_shared";

export function otherRubric(level: Level): string {
  return `# Other round — analysis rubric

The candidate marked this round as "other" — it might be a domain
deep-dive, an architecture critique, a take-home walkthrough, or
something we don't have a dedicated rubric for. Adapt accordingly.
The candidate's next interview is what we're optimizing for.

${levelHeader(level)}

## What to assess

1. **Did the candidate understand the question?**
   - When the prompt was ambiguous, did they clarify before
     answering?
   - Did they restate the prompt in their own words?

2. **Was their answer well-structured?**
   - Did they have a clear opening, middle, and conclusion?
   - Did they explicitly signal transitions ("first… second…
     third…")?
   - Did they avoid backtracking by planning before speaking?

3. **Was their reasoning visible?**
   - Did they show their work, not just the conclusion?
   - Did they consider alternatives?
   - Did they articulate trade-offs?

4. **Engagement with the interviewer**
   - When the interviewer pushed back, did they update their model
     or defend incorrectly?
   - Did they ask the interviewer about the underlying motivation
     for the question?

5. **Honesty about gaps**
   - When they didn't know something, did they say so cleanly,
     or did they fabricate?

6. **Time discipline**
   - Did they pace themselves through the time the interviewer
     gave them?
   - Did they wrap on their own, or did the interviewer have to
     cut them off?

## What you must NOT do
- Do not state or imply a hire / no-hire decision.
- Do not predict whether the candidate "passed" or "failed".
- Do not say "you would have failed" or "you should have passed".
- Do not assign a numeric score that maps onto a leveling band.
- Do not make claims about another company's specific bar.
- Do not characterize the interviewer's likely impression.
`;
}
