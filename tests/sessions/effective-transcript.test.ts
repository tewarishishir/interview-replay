/**
 * Unit tests for `effectiveWordCount`.
 *
 * Pins the two semantics that matter at every call site
 * (Communication-tab speech-pace gauge AND the SESSION sidebar
 * word count on both `/sessions/:id` and the historical report
 * viewer):
 *
 *   1. When `editedText` is `null` we passthrough the stored
 *      `wordCount` (audio-derived) — the transcript hasn't been
 *      touched after transcription service landed the row.
 *
 *   2. When `editedText` is a non-null string we recompute the
 *      count from that text using the SAME tokenization as
 *      `transcription/process.countWords`, so the post-edit gauge
 *      reads "the current transcript" instead of drifting back to
 *      the pre-edit audio-derived count (the 2026-05-24 gauge
 *      regression — a heavily-edited transcript was rendering
 *      "5 words per minute" because the stored `wordCount`
 *      reflected a tiny initial recording).
 */
import { describe, expect, it } from "vitest";

import { effectiveWordCount } from "@/lib/sessions/effective-transcript";

describe("effectiveWordCount", () => {
  it("returns the stored wordCount when editedText is null", () => {
    expect(
      effectiveWordCount({ wordCount: 1234, editedText: null }),
    ).toBe(1234);
  });

  it("returns the stored wordCount when editedText is undefined", () => {
    expect(effectiveWordCount({ wordCount: 1234 })).toBe(1234);
  });

  it("recomputes from editedText when present (overrides audio count)", () => {
    // Three words in the edited string vs. a hugely-different stored
    // count from the original audio — this is the regression case
    // the fix targets.
    expect(
      effectiveWordCount({
        wordCount: 5,
        editedText: "one two three four five six seven eight nine ten",
      }),
    ).toBe(10);
  });

  it("treats an empty edited string as zero words (user cleared the transcript)", () => {
    expect(
      effectiveWordCount({ wordCount: 500, editedText: "" }),
    ).toBe(0);
  });

  it("treats a whitespace-only edited string as zero words", () => {
    expect(
      effectiveWordCount({ wordCount: 500, editedText: "   \n\t  " }),
    ).toBe(0);
  });

  it("ignores punctuation-only tokens (matches transcription countWords)", () => {
    // The canonical audio-derived counter in `transcription/process`
    // filters bare-punctuation tokens out of the count. Mirror
    // that behavior so a post-edit transcript and a pre-edit
    // transcript with identical prose tokenize to the same count.
    expect(
      effectiveWordCount({
        wordCount: 0,
        editedText: "Hello, world! — yes.",
      }),
    ).toBe(3);
  });

  it("collapses runs of whitespace", () => {
    expect(
      effectiveWordCount({
        wordCount: 0,
        editedText: "alpha   beta\n\nbeta\tgamma",
      }),
    ).toBe(4);
  });

  it("regression: gauge no longer reads 5 wpm after a 750-word edit", () => {
    // The original audio captured ~5 words; the candidate edited the
    // transcript to add the rest of the round (≈750 words) before
    // hitting "Re-analyze". The gauge math is
    //   wpm = wordCount / (durationSeconds / 60)
    // so against a 5-minute (300s) recording the pre-fix gauge read
    // 1 wpm; the post-fix gauge reads 150 wpm.
    const edited = Array.from({ length: 750 }, (_, i) => `word${i}`).join(
      " ",
    );
    const wpm = Math.round(
      effectiveWordCount({ wordCount: 5, editedText: edited }) /
        (300 / 60),
    );
    expect(wpm).toBe(150);
  });
});
