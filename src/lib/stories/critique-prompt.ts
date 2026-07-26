/**
 * System prompt and user-message renderer for the Story Bank critique
 * pipeline (`POST /api/stories/critique`).
 *
 * Deliberately separate from `lib/rebuilds/prompt.ts` because the two
 * surfaces differ in three ways:
 *
 *   1. No interview question — story-bank critique evaluates the story
 *      on its own merits (clarity, STAR completeness, specificity,
 *      impact). The "QUESTION THE CANDIDATE IS ANSWERING" block is
 *      replaced by the story's title as topic context.
 *
 *   2. `behavioral_change` dimension omitted — that dimension only
 *      applies to failure-shaped interview questions. Since there is
 *      no question here, the dimension has no meaning and is excluded.
 *      Six dimensions are critiqued instead of seven.
 *
 *   3. `whatILearned` field included — story-bank stories carry a
 *      "what I learned" reflection field that rebuild drafts don't.
 *      It is passed in the prompt for the model's context when
 *      evaluating `star_completeness` and `profile_leverage` but does
 *      not produce a separate output dimension (that would require
 *      forking the `CritiqueResponse` schema, which is out of scope).
 *
 * The guardrails and output schema are UNCHANGED — this runner returns
 * the same `CritiqueResponse` shape as the rebuild route so the
 * existing `CritiqueView` component works without modification.
 *
 * Bump `STORY_CRITIQUE_PROMPT_VERSION` in lockstep with any body
 * change so analytics can trace which prompt produced which critique.
 */

export const STORY_CRITIQUE_PROMPT_VERSION = "2026-05-30.v1" as const;

export const STORY_CRITIQUE_SYSTEM_PROMPT = [
  "You are an expert interview coach reviewing a story from the candidate's Story Bank.",
  "You have access to the candidate's professional profile (projects, stories, technologies, career narrative).",
  "Your job is to critique the STORY — never to rewrite it, never to provide example answer text,",
  "never to suggest specific words they should say.",
  "",
  "Your critique evaluates six dimensions (behavioral_change is intentionally omitted — there is no",
  "specific interview question context here, so that dimension is not applicable):",
  "",
  "1. headline — does the title clearly and concisely state the main outcome of the story?",
  "2. star_completeness — are Situation, Task, Action, and Result all present and distinct?",
  "3. first_person — does the candidate use 'I' for their specific decisions and contributions, not 'we'?",
  "4. quantification — does the Result include a specific measurable outcome (number, percentage, time delta, headcount)?",
  "5. profile_consistency — does the story contradict anything in the candidate's profile? Wrong company name, wrong technology stack, wrong team size, wrong timeframe, role described differently than in the profile?",
  "6. profile_leverage — does the candidate's profile contain stronger or more specific evidence (a more relevant project, a stronger metric, a more specific outcome) that would strengthen this story?",
  "",
  "CRITICAL RULES FOR PROFILE-GROUNDED FEEDBACK:",
  "",
  "A. When you reference content from the candidate's profile, cite the specific profile field",
  "   and quote the field value verbatim. Never paraphrase or reword profile content. Format:",
  "   profile_reference.field_path = 'user_projects[id=X].outcomes_with_metrics' and",
  "   profile_reference.field_value = the exact original text.",
  "",
  "B. Every profile-based suggestion (dimensions 5 and 6) MUST be paired with an ownership",
  "   verification question in what_to_check. Example: 'If you personally owned this outcome,",
  "   consider whether to mention it. If your role in this part of the project was different,",
  "   what's the specific contribution YOU can speak to?' Never instruct the candidate to",
  "   simply 'use' or 'add' a profile detail without prompting verification.",
  "",
  "C. NEVER invent metrics, projects, or specifics. If the profile doesn't contain a specific",
  "   number for what the candidate is talking about, point out the missing metric and ask the",
  "   candidate what verifiable number they can use — do not suggest one.",
  "",
  "D. When the story contradicts the profile, flag it as status='discrepancy' and ask which is",
  "   correct. Do not pick a side. Example: 'Your story says team of 8; your profile lists",
  "   team of 4 for project X. Which is accurate for the moment you're describing?'",
  "",
  "E. NEVER produce text the candidate could plausibly copy verbatim into their interview answer.",
  "   Your what_to_check field must be instructional ('check whether...', 'consider whether...',",
  "   'verify that...'), never a model sentence the candidate could read aloud.",
  "",
  "F. When you have nothing useful to say about a dimension (e.g., the story is fine on that",
  "   dimension), use status='strong' with empty quoted_excerpt and a brief affirmation in",
  "   what_to_check (e.g., 'This is well-structured.'). Do not omit the dimension.",
  "",
  "Output strict JSON conforming to the provided schema. No prose outside the JSON.",
  "Include exactly 6 dimensions — omit behavioral_change.",
].join("\n");

/**
 * Build the user-message body for a story-bank critique. Mirrors
 * `renderRebuildUserPrompt` in structure but:
 *   - Replaces the "QUESTION THE CANDIDATE IS ANSWERING" block with
 *     the story's title as topic context.
 *   - Includes `whatILearned` in the STAR fields for model context.
 *   - Asks for 6 dimensions (behavioral_change omitted).
 */
export function renderStoryCritiqueUserPrompt(args: {
  /** Pre-rendered profile context block from `renderProfileContext`. */
  profileContextBlock: string;
  title: string;
  draft: {
    situation: string;
    task: string;
    action: string;
    result: string;
    whatILearned: string;
  };
}): string {
  const lines: string[] = [];
  lines.push(args.profileContextBlock);

  lines.push("STORY TITLE (use as headline context):");
  lines.push(args.title);
  lines.push("");

  lines.push("CANDIDATE'S STORY DRAFT:");
  lines.push(`- Situation: ${args.draft.situation.trim() || "(empty)"}`);
  lines.push(`- Task: ${args.draft.task.trim() || "(empty)"}`);
  lines.push(`- Action: ${args.draft.action.trim() || "(empty)"}`);
  lines.push(`- Result: ${args.draft.result.trim() || "(empty)"}`);
  lines.push(
    `- What I learned: ${args.draft.whatILearned.trim() || "(not provided)"}`,
  );
  lines.push("");

  lines.push(
    "Critique this story across all six dimensions. Output JSON:",
  );
  lines.push("");
  lines.push("{");
  lines.push('  "overall_assessment": "2-3 sentence read on the story",');
  lines.push('  "dimension_feedback": [');
  lines.push("    {");
  lines.push(
    '      "dimension": "headline" | "star_completeness" | "first_person" | "quantification" | "profile_consistency" | "profile_leverage",',
  );
  lines.push(
    '      "status": "strong" | "needs_work" | "missing" | "discrepancy",',
  );
  lines.push(
    '      "quoted_excerpt": "exact text from the story, or empty string if missing",',
  );
  lines.push('      "profile_reference": {');
  lines.push(
    '        "field_path": "e.g. user_projects[id=abc].outcomes_with_metrics",',
  );
  lines.push(
    '        "field_value": "exact verbatim text from the profile field"',
  );
  lines.push("      },");
  lines.push(
    '      "what_to_check": "instructional sentence; for profile dimensions MUST include ownership verification"',
  );
  lines.push("    }");
  lines.push("  ],");
  lines.push(
    '  "next_step_suggestion": "one sentence recommending the single most impactful revision"',
  );
  lines.push("}");
  lines.push("");
  lines.push(
    "profile_reference is omitted (not present in JSON) for dimensions that don't reference the profile.",
  );
  lines.push(
    "Always include all 6 dimensions in dimension_feedback. Do NOT include behavioral_change.",
  );

  return lines.join("\n");
}
