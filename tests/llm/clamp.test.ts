/**
 * Tests for the input-size caps on the LLM prompt body. C4.
 *
 * These caps are the load-bearing defense against:
 *   - A pathological transcript edit that pads `editedText` with
 *     megabytes of arbitrary text (revenue leak: fixed credit
 *     charge, unbounded LLM provider spend).
 *   - A very-long recording producing a transcript that's still
 *     in-band for billing (≤ 120 min) but wide enough to blow
 *     the prompt budget.
 *   - Many medium-sized artifacts summing past the prompt budget.
 *
 * The clamp helpers are exposed by `@/lib/llm` so tests can pin
 * their behavior without spinning up the full prompt build.
 */
import { describe, expect, it } from "vitest";

import {
  clampArtifactBlocks,
  clampWithHeadAndTail,
  MAX_ARTIFACT_BODY_CHARS,
  MAX_TRANSCRIPT_BODY_CHARS,
} from "@/lib/llm";
import { buildArtifactHeader } from "@/lib/llm/client";

describe("clampWithHeadAndTail", () => {
  it("returns the input unchanged when under the cap", () => {
    const input = "small body";
    expect(clampWithHeadAndTail(input, 1000)).toBe(input);
  });

  it("clamps to <= cap and inserts the truncation marker", () => {
    const input = "x".repeat(10_000);
    const out = clampWithHeadAndTail(input, 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out).toContain("[... transcript truncated for length");
  });

  it("preserves both head and tail of the original input", () => {
    const head = "HEAD_SENTINEL ".repeat(20);
    const tail = " TAIL_SENTINEL".repeat(20);
    const filler = "x".repeat(20_000);
    const input = head + filler + tail;
    const out = clampWithHeadAndTail(input, 2_000);
    expect(out).toContain("HEAD_SENTINEL");
    expect(out).toContain("TAIL_SENTINEL");
  });

  it("realistic worst-case: 120-minute, 200-WPM transcript fits under MAX_TRANSCRIPT_BODY_CHARS", () => {
    // A pathological-but-real candidate: 200 wpm * 120 min * 6
    // chars/word ≈ 144,000 chars. Should not require clamping.
    const realistic = "word ".repeat(200 * 120);
    const out = clampWithHeadAndTail(realistic, MAX_TRANSCRIPT_BODY_CHARS);
    expect(out).toBe(realistic);
  });

  it("malicious case: 5MB editedText is clamped well below the cap", () => {
    const evil = "a".repeat(5_000_000);
    const out = clampWithHeadAndTail(evil, MAX_TRANSCRIPT_BODY_CHARS);
    expect(out.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_BODY_CHARS);
  });
});

describe("clampArtifactBlocks", () => {
  it("returns blocks unchanged when total is under the cap", () => {
    const blocks = [
      { header: "--- Artifact 1 (code) ---", body: "function foo() {}" },
      { header: "--- Artifact 2 (notes) ---", body: "Some notes" },
    ];
    const out = clampArtifactBlocks(blocks, 10_000);
    expect(out).toEqual(blocks);
  });

  it("trims the longest block first, leaving short ones intact", () => {
    const blocks = [
      { header: "--- Artifact 1 (code) ---", body: "x".repeat(10_000) },
      { header: "--- Artifact 2 (notes) ---", body: "tiny" },
    ];
    const out = clampArtifactBlocks(blocks, 2_000);

    expect(out[1]?.body).toBe("tiny");
    expect(out[0]?.body.length).toBeLessThan(10_000);
    const total = out.reduce(
      (acc, b) => acc + b.header.length + 1 + b.body.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(2_000);
  });

  it("preserves at least the header + a stub for every artifact", () => {
    // Pathological: ten 100KB artifacts. Even after clamping every
    // one of them must still be visible to the model so the
    // "candidate uploaded N artifacts" framing is preserved.
    const blocks = Array.from({ length: 10 }, (_, i) => ({
      header: `--- Artifact ${i + 1} (code) ---`,
      body: "x".repeat(100_000),
    }));
    const out = clampArtifactBlocks(blocks, MAX_ARTIFACT_BODY_CHARS);
    expect(out).toHaveLength(10);
    for (const b of out) {
      expect(b.header).toMatch(/Artifact \d+/);
      expect(b.body.length).toBeGreaterThan(0);
    }
  });
});

describe("buildArtifactHeader", () => {
  // Provenance is THE thing that lets the analyzer know whether
  // a "question" artifact is something the candidate confirmed
  // or just an AI guess. Wording matters: the system prompt
  // matches on phrases like "AI-inferred best-guess" — keep this
  // test in sync with both the helper AND the prompt.
  it("user-added artifacts get a plain header (no source tag)", () => {
    const header = buildArtifactHeader(1, {
      artifactType: "question",
      content: "How would you scale this?",
      imageUrl: null,
      displayOrder: 0,
      source: "user_added",
    });
    expect(header).toBe("--- Artifact 1 (question) ---");
  });

  it("user-added artifacts without an explicit source still get the plain header (back-compat)", () => {
    // A future caller that doesn't know about provenance must
    // still typecheck and render correctly.
    const header = buildArtifactHeader(2, {
      artifactType: "code",
      content: "function foo() {}",
      imageUrl: null,
      displayOrder: 1,
    });
    expect(header).toBe("--- Artifact 2 (code) ---");
  });

  it("AI-inferred + candidate-confirmed flips to the trusted tag", () => {
    const header = buildArtifactHeader(1, {
      artifactType: "question",
      content: "Tell me about yourself.",
      imageUrl: null,
      displayOrder: 0,
      source: "ai_inferred",
      aiConfidence: "high",
      userConfirmed: true,
    });
    expect(header).toContain("AI-inferred, candidate-confirmed");
  });

  it("AI-inferred + NOT confirmed surfaces the confidence band", () => {
    const high = buildArtifactHeader(1, {
      artifactType: "question",
      content: "Why our company?",
      imageUrl: null,
      displayOrder: 0,
      source: "ai_inferred",
      aiConfidence: "high",
      userConfirmed: false,
    });
    expect(high).toContain("AI-inferred best-guess (high confidence)");
    expect(high).toContain("not yet confirmed");

    const medium = buildArtifactHeader(2, {
      artifactType: "question",
      content: "Tell me about a conflict.",
      imageUrl: null,
      displayOrder: 1,
      source: "ai_inferred",
      aiConfidence: "medium",
      userConfirmed: false,
    });
    expect(medium).toContain("AI-inferred best-guess (medium confidence)");
  });

  it("AI-inferred 'low' confidence renders distinctly (the analyzer needs the band)", () => {
    // 'low' rows are now surfaced to the candidate AND fed to the
    // analyzer (the candidate is the gate). The analyzer relies on
    // the band string to decide how much to lean on the row, so a
    // 'low' guess MUST render as "low confidence" — not silently
    // collapsed into "medium".
    const header = buildArtifactHeader(1, {
      artifactType: "question",
      content: "Could you explain your approach?",
      imageUrl: null,
      displayOrder: 0,
      source: "ai_inferred",
      aiConfidence: "low",
      userConfirmed: false,
    });
    expect(header).toContain("AI-inferred best-guess (low confidence)");
  });

  it("AI-inferred with missing confidence falls back to medium (defensive)", () => {
    const header = buildArtifactHeader(1, {
      artifactType: "question",
      content: "Why our company?",
      imageUrl: null,
      displayOrder: 0,
      source: "ai_inferred",
      aiConfidence: null,
      userConfirmed: false,
    });
    expect(header).toContain("AI-inferred best-guess (medium confidence)");
  });
});
