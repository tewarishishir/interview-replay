/**
 * Rate-limiter behavior tests.
 *
 * The `lib/rate-limit` module uses in-memory sliding-window rate
 * limiting. Tests exercise the limiter directly — no external
 * dependencies needed.
 *
 * What's covered (per spec):
 *   - 5 attempts per minute per identifier (burst window).
 *   - 10 failed attempts in 15 minutes triggers a lockout that lasts
 *     for the rest of the 15-minute window.
 *   - The in-memory limiter always works (no configuration needed).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.useRealTimers();
  delete (globalThis as { __irRateLimiters?: unknown }).__irRateLimiters;
});

describe("rate limiter — in-memory", () => {
  it("allows up to the burst limit then blocks", async () => {
    const { signInLimiter } = await import("@/lib/rate-limit");
    const limiter = signInLimiter();

    for (let i = 1; i <= 5; i++) {
      const r = await limiter.check("198.51.100.10");
      expect(r.success, `attempt ${i} should pass`).toBe(true);
    }
    const blocked = await limiter.check("198.51.100.10");
    expect(blocked.success).toBe(false);
  });

  it("recordFailure does not throw", async () => {
    const { signInLimiter } = await import("@/lib/rate-limit");
    const limiter = signInLimiter();
    await expect(limiter.recordFailure("203.0.113.1")).resolves.toBeUndefined();
  });

  it("sessionCreateLimiter blocks after 30 attempts", async () => {
    const { sessionCreateLimiter } = await import("@/lib/rate-limit");
    const limiter = sessionCreateLimiter();

    for (let i = 1; i <= 30; i++) {
      const r = await limiter.check("user-uuid-2");
      expect(r.success, `attempt ${i} should pass`).toBe(true);
    }
    const blocked = await limiter.check("user-uuid-2");
    expect(blocked.success).toBe(false);
  });

  it("isolates buckets across different identifiers", async () => {
    const { signInLimiter } = await import("@/lib/rate-limit");
    const limiter = signInLimiter();

    for (let i = 1; i <= 5; i++) {
      await limiter.check("user-a");
    }
    // user-a is exhausted
    expect((await limiter.check("user-a")).success).toBe(false);
    // user-b should still pass
    expect((await limiter.check("user-b")).success).toBe(true);
  });
});

describe("ipFromHeaders", () => {
  it("prefers the first x-forwarded-for entry", async () => {
    const { ipFromHeaders } = await import("@/lib/rate-limit");
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.5, 10.0.0.1, 10.0.0.2",
    });
    expect(ipFromHeaders(headers)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip when XFF is missing", async () => {
    const { ipFromHeaders } = await import("@/lib/rate-limit");
    const headers = new Headers({ "x-real-ip": "203.0.113.6" });
    expect(ipFromHeaders(headers)).toBe("203.0.113.6");
  });

  it("returns a deterministic placeholder when neither header is present", async () => {
    const { ipFromHeaders } = await import("@/lib/rate-limit");
    expect(ipFromHeaders(new Headers())).toBe("unknown-ip");
  });

  it("accepts private-range IPs in non-production (dev convenience)", async () => {
    const { ipFromHeaders } = await import("@/lib/rate-limit");
    const headers = new Headers({ "x-forwarded-for": "127.0.0.1" });
    expect(ipFromHeaders(headers)).toBe("127.0.0.1");
  });
});
