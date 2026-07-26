/**
 * Pass/fail language detector. The InterviewReplay product position is
 * explicit: we are NOT a hire/no-hire prediction tool. The model's
 * system prompt forbids that framing, and this regex is the
 * defense-in-depth check that runs against every generated report
 * before we save it. If the model slips and uses pass/fail
 * language, we surface it as a validation failure and the analyze
 * worker retries once.
 *
 * Patterns are matched case-insensitively against the JSON-stringified
 * report. We deliberately keep the list short and exact-shape so
 * legitimate uses of words like "pass" (e.g. "the function passes
 * an array") in code-flavored quotes don't false-positive.
 *
 * Curated from the spec's section on forbidden framings.
 */

const FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(would|will|did)\s+(not\s+)?(pass|fail)\b/i,
  /\bpass(ed|es)?\s+the\s+(interview|round|loop|bar)\b/i,
  /\bfail(ed|s)?\s+the\s+(interview|round|loop|bar)\b/i,
  /\bhire\s*\/\s*no[-\s]hire\b/i,
  /\bhiring\s+decision\b/i,
  /\bno[-\s]hire\b/i,
  /\bstrong\s+(hire|no[-\s]hire)\b/i,
  /\b(weak|lean(ing)?)\s+(hire|no[-\s]hire)\b/i,
  /\bnot\s+a\s+hire\b/i,
  /\b(meet|met|meets|exceed(s|ed)?)\s+the\s+bar\b/i,
  /\b(below|above)\s+the\s+bar\b/i,
  /\bfailed\s+the\s+bar\b/i,
];

export interface ForbiddenLanguageHit {
  pattern: string;
  excerpt: string;
}

/**
 * Returns the list of forbidden-language matches. Empty array
 * means the report is clean.
 */
export function findForbiddenLanguage(text: string): ForbiddenLanguageHit[] {
  const hits: ForbiddenLanguageHit[] = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    const m = text.match(pattern);
    if (m && typeof m.index === "number") {
      const start = Math.max(0, m.index - 24);
      const end = Math.min(text.length, m.index + m[0].length + 24);
      hits.push({
        pattern: pattern.source,
        excerpt: text.slice(start, end).replace(/\s+/g, " ").trim(),
      });
    }
  }
  return hits;
}

export function containsForbiddenLanguage(text: string): boolean {
  return findForbiddenLanguage(text).length > 0;
}
