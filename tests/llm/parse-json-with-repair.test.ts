/**
 * Regression coverage for `parseJsonWithRepair` — the JSON salvage
 * helper that wraps `JSON.parse` with a `jsonrepair` fallback.
 *
 * The shipped behavior we're pinning: malformed model output that
 * previously crashed `JSON.parse` (and bubbled up as
 * `llm_validation_failed`, refunding the user's credits) now
 * recovers via `jsonrepair`. Each test mirrors a real production
 * failure mode we've seen:
 *
 *   1. Unescaped double-quotes inside a string value — the model
 *      wrapped a candidate quote in `"…"` without escaping the
 *      inner quotes. This is the 2026-05-18 incident pattern.
 *   2. Smart quotes (`“ ” ‘ ’`) leaking from the model's training
 *      data into JSON literals.
 *   3. Trailing commas after the last array / object entry.
 *   4. A response truncated mid-string with no closing `"` / `}`.
 *
 * The helper stays a pure function (no DOM, no LLM provider SDK), so
 * these tests run in the default vitest environment without
 * mocking anything.
 */
import { describe, expect, it } from "vitest";

import { parseJsonWithRepair } from "@/lib/llm";

describe("parseJsonWithRepair", () => {
  it("returns parsed value unchanged on well-formed JSON (no repair attempted)", () => {
    const result = parseJsonWithRepair('{"a":1,"b":["x","y"]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ a: 1, b: ["x", "y"] });
    expect(result.repaired).toBe(false);
  });

  it("recovers from unescaped quotes inside a string value (2026-05-18 incident)", () => {
    // Verbatim shape from the production failure: the model
    // emitted a candidate quote wrapped in `"…"` inside an
    // evidence string, without escaping the inner quotes. This
    // crashes `JSON.parse` at the first inner `"` because the
    // parser closes the outer string early and then sees `, ` as
    // unexpected tokens.
    //
    // Pre-fix: the analyze pipeline surfaced this as
    // `llm_validation_failed` and refunded the user's credits.
    // Post-fix: `jsonrepair` reads the surrounding context and
    // returns a parseable structure.
    const raw =
      '{"evidence":[{"quote":"you know, you know, you know" — repeated throughout every answer"}]}';
    const result = parseJsonWithRepair(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repaired).toBe(true);
    // The exact repaired string isn't load-bearing (jsonrepair
    // picks a reasonable resolution; both "outer string ends
    // early" and "inner quotes escaped" are valid repairs). Pin
    // only that the structural shape survives: an `evidence`
    // array whose first entry has a `quote` field — enough for
    // the report to validate downstream.
    const value = result.value as {
      evidence: Array<{ quote: string }>;
    };
    expect(value.evidence).toHaveLength(1);
    expect(typeof value.evidence[0]!.quote).toBe("string");
    expect(value.evidence[0]!.quote.length).toBeGreaterThan(0);
  });

  it("normalises smart quotes (curly U+201C / U+201D) to plain JSON strings", () => {
    // Sonnet occasionally emits curly quotes when the surrounding
    // prose used them — most often when the system prompt itself
    // contains an em-dash + smart quote in an example. The
    // resulting `“key”: “value”` payload fails `JSON.parse` but
    // `jsonrepair` rewrites the smart quotes to `"`.
    const raw = '{\u201Ckey\u201D: \u201Cvalue\u201D}';
    const result = parseJsonWithRepair(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ key: "value" });
    expect(result.repaired).toBe(true);
  });

  it("repairs a trailing comma in the last array entry", () => {
    // Trailing commas are forbidden in strict JSON but the model
    // sometimes adds one anyway. jsonrepair drops it.
    const raw = '{"items":[1,2,3,]}';
    const result = parseJsonWithRepair(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ items: [1, 2, 3] });
    expect(result.repaired).toBe(true);
  });

  it("closes structures that the model truncated mid-string", () => {
    // A response cut short — e.g. the connection dropped or the
    // model emitted a malformed final token — leaves unbalanced
    // brackets. `jsonrepair` closes them so the partial report is
    // salvageable downstream (the schema validator then decides
    // whether the partial data is usable).
    const raw = '{"a":1,"b":[1,2,3';
    const result = parseJsonWithRepair(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { a: number; b: number[] };
    expect(value.a).toBe(1);
    expect(value.b).toEqual([1, 2, 3]);
    expect(result.repaired).toBe(true);
  });

  it("salvages arbitrary non-JSON text by wrapping it as a JSON string", () => {
    // jsonrepair is intentionally permissive: rather than throw on
    // free-form prose, it wraps the input as a JSON string. This
    // is the right call for our use case — a model that returned
    // an apology paragraph instead of the report still surfaces
    // SOMETHING the schema validator can reject specifically (the
    // top-level shape is wrong) rather than failing earlier with
    // a generic JSON.parse error that obscures what happened.
    const result = parseJsonWithRepair("this is not even close to JSON !!!");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value).toBe("string");
    expect(result.repaired).toBe(true);
  });

  it("returns the ORIGINAL JSON.parse error when even jsonrepair throws (empty input)", () => {
    // The handful of inputs jsonrepair refuses to salvage all
    // boil down to "there's nothing to repair" (empty string,
    // whitespace only). When that happens we surface the original
    // `JSON.parse` error message — not the repair attempt's
    // failure — so the retry-prompt copy blames the model's actual
    // mistake instead of a downstream repair artifact. Always
    // prefixed `not valid JSON:` so the retry classifier in
    // `generateReport` can detect this branch.
    const result = parseJsonWithRepair("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.startsWith("not valid JSON:")).toBe(true);
  });

  it("preserves the `not valid JSON:` prefix so the retry classifier can detect it", () => {
    // The `generateReport` retry path inspects the error prefix
    // to swap the user-message guidance between JSON-shape failures
    // and Zod-schema failures. If this prefix ever drifts, the
    // model will get a generic schema-error retry prompt on a
    // JSON-parse failure and burn the second attempt on the wrong
    // class of fix.
    const result = parseJsonWithRepair("   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^not valid JSON: /);
  });
});
