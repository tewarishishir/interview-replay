/**
 * Pure-unit tests for the Haiku inference response parser.
 *
 * The parser is the gate between LLM provider and the rest of the
 * pipeline: every chunk that ends up as an `artifacts` row goes
 * through it. Tests pin:
 *   - Markdown-fence stripping the model occasionally adds.
 *   - Prose-preamble stripping ("Here are 4 questions:\n\n[...]" —
 *     historically this dropped EVERY inference because the parser
 *     refused to JSON.parse anything that didn't start with `[`).
 *   - Both the bare-array shape and the `{ items: [...] }` self-
 *     correction shape the model sometimes produces.
 *   - All three confidence bands (high/medium/low) survive parsing.
 *     The candidate is the gate — each card surfaces its band so
 *     the candidate can quickly judge before confirming/dismissing.
 *     Historical versions filtered 'low' out at this boundary; the
 *     product now passes everything through.
 *   - Out-of-range offsets are dropped silently rather than blowing
 *     up the whole inference pass.
 *   - Overlapping chunks: keep the first, drop the later overlap.
 *   - Sort order is by `transcript_offset` ascending.
 */
import { describe, expect, it } from "vitest";

import { LlmValidationError } from "@/lib/llm";
import {
  extractJsonPayload,
  parseAndValidate,
} from "@/lib/llm/infer-questions";

const transcriptLength = 1000;

describe("parseAndValidate", () => {
  it("parses a clean JSON array", () => {
    const raw = JSON.stringify([
      {
        inferred_question: "Tell me about yourself.",
        confidence: "high",
        transcript_offset: 0,
        transcript_length: 100,
      },
      {
        inferred_question: "What is a hash map?",
        confidence: "medium",
        transcript_offset: 200,
        transcript_length: 50,
      },
    ]);
    const out = parseAndValidate(raw, transcriptLength);
    expect(out).toHaveLength(2);
    expect(out[0]?.inferred_question).toBe("Tell me about yourself.");
    expect(out[0]?.confidence).toBe("high");
    expect(out[1]?.confidence).toBe("medium");
  });

  it("strips Markdown fence the model occasionally wraps the JSON in", () => {
    const raw =
      "```json\n" +
      JSON.stringify([
        {
          inferred_question: "x",
          confidence: "high",
          transcript_offset: 0,
          transcript_length: 5,
        },
      ]) +
      "\n```";
    const out = parseAndValidate(raw, transcriptLength);
    expect(out).toHaveLength(1);
  });

  it("accepts the {items: [...]} self-correction shape", () => {
    const raw = JSON.stringify({
      items: [
        {
          inferred_question: "q?",
          confidence: "high",
          transcript_offset: 0,
          transcript_length: 5,
        },
      ],
    });
    const out = parseAndValidate(raw, transcriptLength);
    expect(out).toHaveLength(1);
  });

  it("preserves all three confidence bands (high, medium, low) so the candidate can decide", () => {
    // Regression: a single 'low' row used to throw
    // LlmValidationError, which the worker swallowed into "zero
    // inferred questions". The fix accepts every band; each card
    // displays its confidence so the candidate (not us) decides
    // what to confirm or dismiss.
    const raw = JSON.stringify([
      {
        inferred_question: "Tell me about yourself.",
        confidence: "high",
        transcript_offset: 0,
        transcript_length: 100,
      },
      {
        inferred_question: "borderline",
        confidence: "low",
        transcript_offset: 200,
        transcript_length: 5,
      },
      {
        inferred_question: "Why our company?",
        confidence: "medium",
        transcript_offset: 400,
        transcript_length: 50,
      },
    ]);
    const out = parseAndValidate(raw, transcriptLength);
    expect(out).toHaveLength(3);
    expect(out.map((i) => i.confidence)).toEqual(["high", "low", "medium"]);
    // Sorted by transcript_offset.
    expect(out.map((i) => i.inferred_question)).toEqual([
      "Tell me about yourself.",
      "borderline",
      "Why our company?",
    ]);
  });

  it("preserves an all-low response (each row is still a candidate-judgable suggestion)", () => {
    const raw = JSON.stringify([
      {
        inferred_question: "guess A",
        confidence: "low",
        transcript_offset: 0,
        transcript_length: 5,
      },
      {
        inferred_question: "guess B",
        confidence: "low",
        transcript_offset: 100,
        transcript_length: 5,
      },
    ]);
    const out = parseAndValidate(raw, transcriptLength);
    expect(out).toHaveLength(2);
    expect(out.every((i) => i.confidence === "low")).toBe(true);
  });

  it("strips a prose preamble Haiku occasionally adds before the JSON array", () => {
    // Real-world Haiku output (paraphrased): the model agrees to
    // return JSON, then politely narrates what it's about to do.
    // The parser must look past the preamble — historically the
    // raw `JSON.parse` call blew up here and the worker dropped
    // every inference for the session.
    const raw =
      "Here are the 2 inferred questions for this transcript:\n\n" +
      JSON.stringify([
        {
          inferred_question: "Tell me about yourself.",
          confidence: "high",
          transcript_offset: 0,
          transcript_length: 100,
        },
        {
          inferred_question: "What's a project you're proud of?",
          confidence: "medium",
          transcript_offset: 200,
          transcript_length: 80,
        },
      ]) +
      "\n\nLet me know if you'd like me to refine any of these.";
    const out = parseAndValidate(raw, transcriptLength);
    expect(out).toHaveLength(2);
    expect(out[0]?.inferred_question).toBe("Tell me about yourself.");
  });

  it("strips a prose preamble around an {items: [...]} object", () => {
    const raw =
      "Sure! Here are the inferred questions:\n\n" +
      JSON.stringify({
        items: [
          {
            inferred_question: "Why Google?",
            confidence: "high",
            transcript_offset: 0,
            transcript_length: 50,
          },
        ],
      });
    const out = parseAndValidate(raw, transcriptLength);
    expect(out).toHaveLength(1);
    expect(out[0]?.inferred_question).toBe("Why Google?");
  });

  it("accepts the {questions: [...]} and {results: [...]} self-correction shapes", () => {
    const rawQuestions = JSON.stringify({
      questions: [
        {
          inferred_question: "q?",
          confidence: "high",
          transcript_offset: 0,
          transcript_length: 5,
        },
      ],
    });
    expect(parseAndValidate(rawQuestions, transcriptLength)).toHaveLength(1);

    const rawResults = JSON.stringify({
      results: [
        {
          inferred_question: "r?",
          confidence: "medium",
          transcript_offset: 0,
          transcript_length: 5,
        },
      ],
    });
    expect(parseAndValidate(rawResults, transcriptLength)).toHaveLength(1);
  });

  it("extractJsonPayload finds the JSON array even when the model prepends prose", () => {
    expect(extractJsonPayload("[1,2,3]")).toBe("[1,2,3]");
    expect(extractJsonPayload("```json\n[1,2,3]\n```")).toBe("[1,2,3]");
    expect(
      extractJsonPayload("Here you go:\n\n[{\"a\":1},{\"b\":2}]\n\nDone."),
    ).toBe('[{"a":1},{"b":2}]');
    // Strings containing brackets must not confuse the matcher.
    expect(
      extractJsonPayload(
        'sure: [{"q":"do you like [brackets]?","n":1}] thanks',
      ),
    ).toBe('[{"q":"do you like [brackets]?","n":1}]');
  });

  it("drops chunks whose (offset, length) escape the transcript", () => {
    // The model occasionally hallucinates offsets in long inputs.
    // Silent drop is friendlier than blowing up the inference pass —
    // the candidate just sees one fewer card.
    const raw = JSON.stringify([
      {
        inferred_question: "in-range",
        confidence: "high",
        transcript_offset: 100,
        transcript_length: 50,
      },
      {
        inferred_question: "out-of-range",
        confidence: "high",
        transcript_offset: 950,
        transcript_length: 100,
      },
    ]);
    const out = parseAndValidate(raw, 1000);
    expect(out).toHaveLength(1);
    expect(out[0]?.inferred_question).toBe("in-range");
  });

  it("sorts by transcript_offset and drops overlapping chunks", () => {
    // Out-of-order input with one overlap. The cheaper shape we
    // expose to the rest of the pipeline is "non-overlapping,
    // ascending" — the review UI walks the array in order to render
    // cards top-to-bottom.
    const raw = JSON.stringify([
      {
        inferred_question: "second",
        confidence: "high",
        transcript_offset: 200,
        transcript_length: 50,
      },
      {
        inferred_question: "first",
        confidence: "high",
        transcript_offset: 0,
        transcript_length: 100,
      },
      {
        inferred_question: "overlaps-with-first",
        confidence: "high",
        transcript_offset: 50,
        transcript_length: 200,
      },
    ]);
    const out = parseAndValidate(raw, transcriptLength);
    expect(out).toHaveLength(2);
    expect(out[0]?.inferred_question).toBe("first");
    expect(out[1]?.inferred_question).toBe("second");
  });

  it("throws LlmValidationError on invalid JSON (the OUTER shape is broken)", () => {
    expect(() => parseAndValidate("not json", transcriptLength)).toThrow(
      LlmValidationError,
    );
  });

  it("throws LlmValidationError when the payload isn't an array (and isn't a known wrapper)", () => {
    // A bare object with no recognised key is genuinely unparseable.
    // Distinct from "an array containing some bad rows" — the
    // latter survives now.
    const raw = JSON.stringify({ unexpected: "shape" });
    expect(() => parseAndValidate(raw, transcriptLength)).toThrow(
      LlmValidationError,
    );
  });

  it("drops individual bad rows but KEEPS the good ones (the original 'low' bug pattern)", () => {
    // Regression: the parser used to safeParse the whole array,
    // which meant a single malformed row (missing field, wrong
    // type, oversized question, garbage offset) poisoned every
    // OTHER inference in the same batch. The worker swallowed the
    // resulting LlmValidationError into "zero questions" and the
    // candidate saw an empty review screen.
    const raw = JSON.stringify([
      {
        inferred_question: "good row 1",
        confidence: "high",
        transcript_offset: 0,
        transcript_length: 50,
      },
      {
        inferred_question: "missing offset/length",
        confidence: "high",
      },
      {
        // empty string fails the min(1) constraint
        inferred_question: "",
        confidence: "high",
        transcript_offset: 100,
        transcript_length: 5,
      },
      {
        // negative offset fails the nonnegative constraint
        inferred_question: "negative offset",
        confidence: "medium",
        transcript_offset: -1,
        transcript_length: 5,
      },
      {
        // wrong type for confidence
        inferred_question: "kinda-high",
        confidence: "kinda high",
        transcript_offset: 200,
        transcript_length: 5,
      },
      {
        // > 280 chars fails the max constraint
        inferred_question: "x".repeat(500),
        confidence: "high",
        transcript_offset: 300,
        transcript_length: 5,
      },
      {
        inferred_question: "good row 2",
        confidence: "medium",
        transcript_offset: 400,
        transcript_length: 50,
      },
    ]);
    const out = parseAndValidate(raw, transcriptLength);
    expect(out.map((i) => i.inferred_question)).toEqual([
      "good row 1",
      "good row 2",
    ]);
  });

  it("slices to 50 items rather than rejecting the batch when the model overshoots the cap", () => {
    // Previously the schema's `.max(50)` constraint rejected the
    // whole array if the model returned 51+. Same brittleness
    // pattern — slice instead.
    const items = Array.from({ length: 75 }, (_, i) => ({
      inferred_question: `question ${i}`,
      confidence: "high" as const,
      transcript_offset: i * 10,
      transcript_length: 5,
    }));
    const raw = JSON.stringify(items);
    const out = parseAndValidate(raw, 10_000);
    expect(out).toHaveLength(50);
    // Sliced from the head, then sorted (offsets are already
    // ascending so the head IS the prefix).
    expect(out[0]?.inferred_question).toBe("question 0");
    expect(out[49]?.inferred_question).toBe("question 49");
  });

  it("doesn't run unbounded safeParse on a runaway response (caps work scaled)", () => {
    // A pathological response with thousands of items must be
    // bounded even before the per-item validate loop, so the
    // worker can't be stalled by a megabyte of inference rows.
    // The parser caps at 2× MAX_INFERENCE_ITEMS = 100 candidates
    // and stops collecting at 50 valid rows.
    const items = Array.from({ length: 5_000 }, (_, i) => ({
      inferred_question: `question ${i}`,
      confidence: "high" as const,
      transcript_offset: i * 10,
      transcript_length: 5,
    }));
    const raw = JSON.stringify(items);
    const out = parseAndValidate(raw, 1_000_000);
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it("extractJsonPayload handles empty / whitespace input without crashing", () => {
    expect(extractJsonPayload("")).toBe("");
    expect(extractJsonPayload("   \n  ")).toBe("");
    // Empty string is then handed to JSON.parse by parseAndValidate
    // which throws → wrapped in LlmValidationError → caught by
    // the runInferencePass wrapper. Verifying the bottom of the
    // stack here keeps the contract honest.
    expect(() => parseAndValidate("", transcriptLength)).toThrow(
      LlmValidationError,
    );
  });
});
