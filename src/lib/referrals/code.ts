import { randomBytes } from "node:crypto";

/**
 * Referral code generation + normalization.
 *
 * Why Crockford base32:
 *   - 32 symbols = 5 bits per char, so an 8-char code carries 40 bits
 *     (~1.1 trillion values). Birthday-paradox collision odds are
 *     ~50% only after ~1.5 million users — at our scale, the
 *     `ensureReferralCode` retry loop (max 3 attempts) is a safety
 *     net, not a hot path.
 *   - The alphabet excludes `I`, `L`, `O`, `U` to avoid visual
 *     ambiguity (`I/1`, `L/1`, `O/0`) and avoid spelling unfortunate
 *     words. Codes are uppercase by convention; we accept lowercase
 *     on lookup via `normalizeReferralCode`.
 *
 * Why not just slice a UUID:
 *   - Codes show up in URLs and Account-page UI; mixed-case hex
 *     leaks "this is a UUID prefix" and can't be rotated for abuse.
 *     A purpose-built code is opaque, short, and rotatable.
 */

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const REFERRAL_CODE_LENGTH = 8;

/**
 * Generate a single fresh referral code. Cryptographically random
 * (`crypto.randomBytes`) so even a coordinated probe campaign can't
 * predict the next code from prior issuances.
 *
 * No DB lookup here — collisions are checked at insert time by
 * `ensureReferralCode` via the `users_referral_code_key` unique
 * index.
 */
export function generateReferralCode(): string {
  const bytes = randomBytes(REFERRAL_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    // Bias is negligible: 256 % 32 === 0 exactly, so each byte maps
    // to one alphabet symbol with uniform probability. No rejection
    // sampling needed. The non-null assertion is safe here because
    // `bytes.length === REFERRAL_CODE_LENGTH` and the index is in
    // range — TS just can't prove it from `Buffer`'s typing.
    out += CROCKFORD_ALPHABET[bytes[i]! % 32];
  }
  return out;
}

/**
 * Normalize a referral code submitted by a user (e.g. from a
 * `?ref=` query string or a paste into a form). Trims whitespace,
 * uppercases, and strips characters outside the Crockford alphabet.
 *
 * Returns `null` for empty / wrong-shape input so callers can
 * silently no-op attribution rather than surface a "bad code"
 * error to a brand-new user. The signup page treats invalid codes
 * the same as no code at all.
 *
 * NOTE: we do NOT remap `O→0` / `I→1` / `L→1` here. The codes we
 * issue never contain those letters, so a code containing them is
 * by definition forged or mistyped — silently dropping it is the
 * right behavior (we'd rather not credit a typo'd referrer's
 * account by accident).
 */
export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .trim()
    .toUpperCase()
    .split("")
    .filter((ch) => CROCKFORD_ALPHABET.includes(ch))
    .join("");
  if (cleaned.length !== REFERRAL_CODE_LENGTH) return null;
  return cleaned;
}
