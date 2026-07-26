/**
 * Sanitize a candidate redirect path so we never bounce a user to an
 * attacker-controlled origin via `?callbackUrl=…` or the
 * `x-ir-pathname` header.
 *
 * Rules — a value is accepted iff ALL of the following hold:
 *   1. It is a string (FormData entries can be `File`).
 *   2. Its first character is `/` (relative path).
 *   3. Its second character is NOT `/` (would be `//evil.com`,
 *      a protocol-relative URL).
 *   4. Its second character is NOT `\` (some browsers historically
 *      normalize `/\evil.com` toward `//evil.com`).
 *   5. After normalizing percent-encoded slashes, neither `//` nor
 *      `/\` appears at the start. We refuse `/%2Fevil.com` too,
 *      because a downstream consumer that decodes before parsing
 *      would treat it like `//evil.com`.
 *   6. It parses, when resolved against an arbitrary base, to a URL
 *      whose host equals that base's host. This is the ultimate
 *      "did the URL parser disagree with our regex?" backstop.
 *
 * Anything that fails collapses to the supplied fallback.
 *
 * Centralizing this in one module means signin, signup, OAuth, and
 * the `(app)/layout.tsx` `x-ir-pathname` round-trip all share
 * one implementation — no drift between five copies of the regex.
 */

const SENTINEL_HOST = "interview-replay.invalid";

export function sanitizeCallback(
  raw: unknown,
  fallback: string = "/dashboard",
): string {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  if (raw[0] !== "/") return fallback;
  if (raw[1] === "/" || raw[1] === "\\") return fallback;

  // Reject percent-encoded leading-slash tricks like `/%2Fevil.com`.
  // Lowercase compare so `/%2F` and `/%2f` both match.
  const lowered = raw.toLowerCase();
  if (
    lowered.startsWith("/%2f") ||
    lowered.startsWith("/%5c") || // %5C = backslash
    lowered.startsWith("/\\")
  ) {
    return fallback;
  }

  // Final backstop: parse against a sentinel base and verify the
  // resolved URL stays on that sentinel. Any host change means the
  // input was actually absolute / protocol-relative / used some
  // exotic separator the regex above missed.
  try {
    const resolved = new URL(raw, `https://${SENTINEL_HOST}`);
    if (resolved.host !== SENTINEL_HOST) return fallback;
  } catch {
    return fallback;
  }

  return raw;
}
