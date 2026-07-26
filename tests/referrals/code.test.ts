/**
 * Pure-function tests for the referral code generator and
 * normalizer. No DB; these are the cheapest tests in the suite.
 */
import { describe, expect, it } from "vitest";

import {
  generateReferralCode,
  normalizeReferralCode,
  REFERRAL_CODE_LENGTH,
} from "@/lib/referrals/code";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

describe("generateReferralCode", () => {
  it("returns codes of the expected length", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateReferralCode();
      expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
    }
  });

  it("only emits Crockford-base32 characters", () => {
    for (let i = 0; i < 100; i += 1) {
      const code = generateReferralCode();
      for (const ch of code) {
        expect(CROCKFORD_ALPHABET).toContain(ch);
      }
    }
  });

  it("avoids the visually-ambiguous I/L/O/U letters", () => {
    // 1000 codes is plenty to flush out a regression where one of
    // the excluded letters slipped back into the alphabet.
    for (let i = 0; i < 1000; i += 1) {
      const code = generateReferralCode();
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  it("produces effectively-unique codes across many draws", () => {
    // 40 bits of entropy: a 1000-draw collision would mean the RNG
    // is broken. We're exercising the "no obvious collision" path,
    // not the birthday-paradox math.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generateReferralCode());
    }
    expect(seen.size).toBe(1000);
  });
});

describe("normalizeReferralCode", () => {
  it("uppercases and trims the input", () => {
    const code = generateReferralCode();
    expect(normalizeReferralCode(`  ${code.toLowerCase()}  `)).toBe(code);
  });

  it("returns null for non-string input", () => {
    expect(normalizeReferralCode(undefined)).toBeNull();
    expect(normalizeReferralCode(null)).toBeNull();
    expect(normalizeReferralCode(42)).toBeNull();
    expect(normalizeReferralCode({})).toBeNull();
  });

  it("returns null when the cleaned input has the wrong length", () => {
    expect(normalizeReferralCode("ABC")).toBeNull();
    expect(normalizeReferralCode("ABCDEFGHIJ")).toBeNull();
    expect(normalizeReferralCode("")).toBeNull();
  });

  it("strips characters outside the Crockford alphabet before length check", () => {
    // Hyphens and spaces inside an otherwise-valid code should be
    // tolerated — users will paste these from formatted links.
    expect(normalizeReferralCode("ABCD-EFGH")).toBe("ABCDEFGH");
  });

  it("returns null when stripped characters leave a wrong-length code", () => {
    // The visually-ambiguous letters are NOT in the alphabet, so
    // they get stripped — which leaves the input one short.
    expect(normalizeReferralCode("ABCDEFGI")).toBeNull();
  });
});
