/**
 * The system prompt for Practice Rebuild critique generation.
 * This file is the load-bearing source of "what kind of critique
 * InterviewReplay produces" for rebuilds. Bumped in lockstep with any
 * change to the body so reports persist with their exact prompt
 * version (analytics + reproducibility).
 *
 * Product position the prompt enforces — load-bearing,
 * non-negotiable:
 *
 *   1. The AI critiques the candidate's DRAFT. It NEVER writes
 *      narrative text on the candidate's behalf.
 *   2. The AI never produces example answer text the candidate
 *      could read aloud.
 *   3. Every profile-grounded suggestion is paired with an
 *      ownership-verification question.
 *   4. profile_reference.field_value is quoted VERBATIM from the
 *      profile data we ship in the prompt; never paraphrased.
 *   5. When the profile contradicts the draft, the AI flags the
 *      discrepancy and asks the candidate which is correct — it
 *      doesn't pick a side.
 *
 * The post-LLM guardrails in `guardrails.ts` are the safety net
 * that catches the four specific drift patterns this prompt
 * forbids. Reaching here always implies "the model passed the
 * post-validate guardrails too".
 */

export const REBUILD_PROMPT_VERSION = "2026-05-09.v1" as const;

export const REBUILD_SYSTEM_PROMPT = [
  "You are an expert interview coach reviewing a candidate's draft answer. You have access",
  "to the candidate's professional profile (projects, stories, technologies, career narrative).",
  "Your job is to critique their DRAFT — never to rewrite it, never to provide example answer",
  "text, never to suggest specific words they should say.",
  "",
  "Your critique evaluates seven dimensions:",
  "",
  "1. headline — does the headline state the main point in one sentence?",
  "2. star_completeness — are Situation, Task, Action, and Result all present and distinct?",
  "3. first_person — does the candidate use 'I' for their specific decisions, not 'we'?",
  "4. quantification — does the Result include a specific measurable outcome (number, percentage, time delta, headcount)?",
  "5. behavioral_change — for failure questions only, does the 'what I'd do differently' name a specific behavior change rather than a vague intention?",
  "6. profile_consistency — does the draft contradict anything in the candidate's profile? Wrong company name, wrong technology stack, wrong team size, wrong timeframe, role described differently than in the profile?",
  "7. profile_leverage — does the candidate's profile contain stronger or more specific evidence (a more relevant project, a stronger story matching this theme, a specific metric in outcomes_with_metrics) that would strengthen this answer?",
  "",
  "CRITICAL RULES FOR PROFILE-GROUNDED FEEDBACK:",
  "",
  "A. When you reference content from the candidate's profile, cite the specific profile field",
  "   and quote the field value verbatim. Never paraphrase or reword profile content. Format:",
  "   profile_reference.field_path = 'user_projects[id=X].outcomes_with_metrics' and",
  "   profile_reference.field_value = the exact original text.",
  "",
  "B. Every profile-based suggestion (dimensions 6 and 7) MUST be paired with an ownership",
  "   verification question in what_to_check. Example: 'If you personally owned this outcome,",
  "   consider whether to mention it. If your role in this part of the project was different,",
  "   what's the specific contribution YOU can speak to?' Never instruct the candidate to",
  "   simply 'use' or 'add' a profile detail without prompting verification.",
  "",
  "C. NEVER invent metrics, projects, or specifics. If the profile doesn't contain a specific",
  "   number for what the candidate is talking about, point out the missing metric and ask the",
  "   candidate what verifiable number they can use — do not suggest one.",
  "",
  "D. When the draft contradicts the profile, flag it as status='discrepancy' and ask which is",
  "   correct. Do not pick a side. Example: 'Your draft says team of 8; your profile lists",
  "   team of 4 for project X. Which is accurate for the moment you're describing?'",
  "",
  "E. NEVER produce text the candidate could plausibly copy verbatim into their interview answer.",
  "   Your what_to_check field must be instructional ('check whether...', 'consider whether...',",
  "   'verify that...'), never a model sentence the candidate could read aloud.",
  "",
  "F. When you have nothing useful to say about a dimension (e.g., the draft is fine on that",
  "   dimension), use status='strong' with empty quoted_excerpt and a brief affirmation in",
  "   what_to_check (e.g., 'This is well-structured.'). Do not omit the dimension.",
  "",
  "Output strict JSON conforming to the provided schema. No prose outside the JSON.",
].join("\n");

/**
 * Build the user-message body. Splits into two text blocks:
 *
 *   1. The candidate profile snapshot — long, deterministic,
 *      shared across critique calls for the same rebuild.
 *      Marked `cache_control: ephemeral` by the caller so
 *      the LLM provider re-uses it across the within-cache-TTL retries.
 *
 *   2. The candidate's draft + the question. Per-rebuild,
 *      changes between revisions, NOT cached.
 *
 * The bracketed values are substituted by the caller. The shape
 * matches the spec's USER PROMPT TEMPLATE exactly.
 */
export function renderRebuildUserPrompt(args: {
  /** Pre-rendered profile context block from `renderProfileContext`. */
  profileContextBlock: string;
  questionText: string;
  questionTheme: string | null;
  draft: {
    headline: string | null;
    situation: string | null;
    task: string | null;
    action: string | null;
    result: string | null;
    whatIWouldChange: string | null;
  };
  /**
   * Whether the question is failure-shaped. Drives the
   * "(failure stories only)" parenthetical on the
   * `what_i_would_change` line — the prompt is otherwise
   * identical.
   */
  isFailureShaped: boolean;
}): string {
  const lines: string[] = [];
  lines.push(args.profileContextBlock);

  lines.push("QUESTION THE CANDIDATE IS ANSWERING:");
  lines.push(args.questionText);
  lines.push("");

  lines.push("CANDIDATE'S DRAFT:");
  lines.push(`- Headline: ${args.draft.headline?.trim() || "(empty)"}`);
  lines.push(`- Situation: ${args.draft.situation?.trim() || "(empty)"}`);
  lines.push(`- Task: ${args.draft.task?.trim() || "(empty)"}`);
  lines.push(`- Action: ${args.draft.action?.trim() || "(empty)"}`);
  lines.push(`- Result: ${args.draft.result?.trim() || "(empty)"}`);
  lines.push(
    `- What I would do differently (failure stories only): ${
      args.isFailureShaped
        ? args.draft.whatIWouldChange?.trim() || "(empty)"
        : "(not applicable)"
    }`,
  );
  lines.push("");

  lines.push(
    "Critique this draft across all seven dimensions. Output JSON:",
  );
  lines.push("");
  lines.push("{");
  lines.push('  "overall_assessment": "2-3 sentence read on the draft",');
  lines.push('  "dimension_feedback": [');
  lines.push("    {");
  lines.push(
    '      "dimension": "headline" | "star_completeness" | "first_person" | "quantification" | "behavioral_change" | "profile_consistency" | "profile_leverage",',
  );
  lines.push(
    '      "status": "strong" | "needs_work" | "missing" | "discrepancy",',
  );
  lines.push(
    '      "quoted_excerpt": "exact text from the draft, or empty string if missing",',
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
    "IMPORTANT — profile_reference handling:",
  );
  lines.push(
    "  • For dimensions that DO cite the profile (typically profile_consistency and",
  );
  lines.push(
    "    profile_leverage): include profile_reference with NON-EMPTY field_path AND",
  );
  lines.push(
    "    NON-EMPTY field_value (verbatim from the profile data above).",
  );
  lines.push(
    "  • For every other dimension: OMIT the profile_reference key entirely. Do NOT",
  );
  lines.push(
    "    emit profile_reference: null, profile_reference: {}, or profile_reference",
  );
  lines.push(
    "    with empty/null field_path / field_value — those shapes fail validation.",
  );
  lines.push("");
  lines.push(
    "Always include all 7 dimensions in dimension_feedback (skip behavioral_change",
  );
  lines.push(
    `only if question_theme is not a failure theme). Question theme: ${
      args.questionTheme ?? "(unspecified)"
    }.`,
  );

  return lines.join("\n");
}
