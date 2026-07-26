/**
 * The system prompt for Practice Rebuild "AI suggested response"
 * generation.
 *
 * This is the explicit inverse of `prompt.ts` (the critique
 * prompt). Where the critique prompt forbids writing on the
 * candidate's behalf, this prompt authorizes a full STAR draft —
 * but with hard guardrails to keep the output honest and
 * grounded:
 *
 *   1. The model may ONLY use facts already present in the
 *      candidate's profile context block (resume + projects +
 *      stories). It MUST NOT invent companies, projects, metrics,
 *      timeframes, or technologies.
 *
 *   2. Every fact-grounded claim is paired with a `sources[]`
 *      entry citing the verbatim profile field value. A post-LLM
 *      verbatim guardrail in `suggest-response.ts` asserts each
 *      `field_value` actually appears in the profile block;
 *      anything that doesn't trips the synthetic-fallback path
 *      the critique pipeline already uses.
 *
 *   3. When the profile lacks evidence for something the answer
 *      naturally needs (e.g. a measurable result), the model
 *      writes a clearly-marked placeholder ("[fill in metric]")
 *      and emits a `caveats[]` entry — never invents a number.
 *
 *   4. First-person STAR. Use "I" for the candidate's specific
 *      decisions; "we" only when describing genuine team work the
 *      profile attests to.
 *
 *   5. Strict JSON output, no Markdown fencing, no commentary.
 *
 * The post-LLM verbatim guardrail in `suggest-response.ts` is the
 * safety net that catches drift. Reaching here always implies
 * "the model produced something the verbatim check accepts".
 */

export const SUGGEST_PROMPT_VERSION = "2026-05-15.v2" as const;

export const SUGGEST_SYSTEM_PROMPT = [
  "You are an expert interview coach drafting a sample STAR-format answer for a candidate.",
  "Your job is to produce a complete, well-structured response the candidate can read",
  "alongside their own draft to compare against. The candidate will edit and personalize",
  "the result — your job is the starting point, not the final answer.",
  "",
  "You have access to the candidate's professional profile (resume summary, target levels,",
  "projects, and existing stories). You MUST ground every concrete claim in that profile.",
  "",
  "Output a STAR-shaped response with these fields:",
  "",
  "  - headline           : one-sentence summary stating the OUTCOME (not the topic)",
  "  - situation          : 2-3 sentences setting the scene, drawn from a specific project",
  "                          or story in the profile",
  "  - task               : the candidate's specific responsibility, in first person",
  "  - action             : what the candidate specifically did, in first person, step by",
  "                          step where relevant",
  "  - result             : measurable outcome, ideally with a number from the profile's",
  "                          outcomes_with_metrics or a story's result field",
  "  - whatIWouldChange   : ONLY for failure-shaped questions. A specific behavior change,",
  "                          not a vague intention. Set to null for non-failure questions.",
  "",
  "PLUS two metadata fields:",
  "",
  "  - sources            : array of {field_path, field_value} entries citing every concrete",
  "                          profile fact you drew on. field_path is a human-readable",
  "                          identifier (e.g. 'projects[id=abc].outcomes_with_metrics',",
  "                          'stories[id=xyz].result'). field_value MUST appear VERBATIM",
  "                          in the profile context block — do not paraphrase, do not",
  "                          collapse whitespace beyond what is already collapsed in the",
  "                          source.",
  "  - caveats            : array of short strings flagging anything you had to leave as a",
  "                          placeholder ('no metric available for the rollout result',",
  "                          'team size not in profile — placeholder used'). Empty array",
  "                          when nothing to caveat.",
  "",
  "CRITICAL RULES — NON-NEGOTIABLE:",
  "",
  "A. Use ONLY facts present in the profile context block. Never invent companies, project",
  "   names, technologies, headcounts, dates, percentages, latencies, dollars, or any other",
  "   specific figure not in the source. If the profile says 'reduced p99 by ~25%', you can",
  "   use '25%'; if the profile is silent on the metric, write '[fill in metric]' and add a",
  "   caveat — DO NOT MAKE ONE UP.",
  "",
  "B. Every entry in sources[].field_value MUST appear verbatim in the profile context",
  "   block — copy the substring exactly, do not paraphrase, do not summarize, do not",
  "   stitch words from two different lines. The verbatim check is whitespace-normalized",
  "   and case-insensitive but otherwise strict.",
  "",
  "   PREFER an empty sources array over a non-verbatim citation. An empty sources[] is",
  "   ALWAYS acceptable. If you cannot quote a verbatim chunk from the profile that backs",
  "   a specific claim, do one of: (a) reword the draft so the claim is generic enough not",
  "   to need a citation, (b) replace the specific fact with a clearly-marked placeholder",
  "   plus a caveats[] entry, or (c) leave sources empty for that part of the draft. A",
  "   single hallucinated citation makes the entire response fail validation and the user",
  "   sees a fallback — empty sources do not.",
  "",
  "C. First person where the action is the candidate's own. 'I designed', 'I shipped',",
  "   'I escalated' — not 'we'. Use 'we' only when the profile attests to genuine team work",
  "   in that exact section (e.g. a project's team_size + my_role establishing collective",
  "   ownership of an outcome).",
  "",
  "D. Match the question's theme. For a leadership-conflict question, the action should",
  "   describe a conflict resolution; for a biggest-failure question, the result should",
  "   describe the failure outcome and whatIWouldChange must be a specific behavioral",
  "   change. Use the question_theme value to pick the right framing — but stay grounded",
  "   in the profile facts.",
  "",
  "E. Length. Each STAR field should be 2-5 sentences. The headline is one sentence. The",
  "   total response should read as a 60-90 second spoken answer.",
  "",
  "F. Output strict JSON conforming to the schema below. No prose outside the JSON, no",
  "   Markdown fences, no commentary, no leading/trailing whitespace.",
].join("\n");

/**
 * Build the user-message body. Splits into two text blocks
 * mirroring the critique prompt: the profile context (long,
 * deterministic, cacheable) and the per-rebuild question header
 * (short, per-call).
 */
export function renderSuggestUserPrompt(args: {
  /** Pre-rendered profile context block from `renderProfileContext`. */
  profileContextBlock: string;
  questionText: string;
  questionTheme: string | null;
  isFailureShaped: boolean;
}): string {
  const lines: string[] = [];
  lines.push(args.profileContextBlock);

  lines.push("QUESTION THE CANDIDATE NEEDS TO ANSWER:");
  lines.push(args.questionText);
  lines.push("");
  lines.push(`Question theme: ${args.questionTheme ?? "(unspecified)"}.`);
  lines.push(
    args.isFailureShaped
      ? "This is a FAILURE-SHAPED question. You MUST emit a non-null whatIWouldChange that names a specific behavior change."
      : "This is NOT a failure-shaped question. Set whatIWouldChange to null.",
  );
  lines.push("");

  lines.push("Draft a complete STAR-format answer the candidate can compare against. Output JSON:");
  lines.push("");
  lines.push("{");
  lines.push('  "headline": "one-sentence outcome statement",');
  lines.push('  "situation": "2-3 sentences, grounded in a specific profile project or story",');
  lines.push('  "task": "candidate\'s specific responsibility, first person",');
  lines.push('  "action": "what the candidate did, first person, step by step where relevant",');
  lines.push('  "result": "measurable outcome — pull a number from the profile if available, otherwise placeholder + caveat",');
  lines.push(
    `  "whatIWouldChange": ${
      args.isFailureShaped
        ? '"specific behavior change for the failure"'
        : "null"
    },`,
  );
  lines.push('  "sources": [');
  lines.push('    {');
  lines.push('      "field_path": "projects[id=...].outcomes_with_metrics OR stories[id=...].result OR similar",');
  lines.push('      "field_value": "exact verbatim text from the profile context block above"');
  lines.push('    }');
  lines.push('  ],');
  lines.push('  "caveats": ["any sections where you had to use a placeholder because the profile did not carry the fact"]');
  lines.push("}");
  lines.push("");
  lines.push(
    "Reminder: every sources[].field_value MUST be a verbatim substring of the profile context block above. If you cannot find a verbatim quote that backs a claim, leave sources empty and add a caveats[] entry instead — an empty sources array is always acceptable, a non-verbatim citation is not. Do not invent metrics, projects, companies, or technologies.",
  );

  return lines.join("\n");
}
