import "server-only";

import { isProduction } from "@/lib/env";

/**
 * In-memory sliding-window rate limiting for self-hosted deployments.
 *
 * Not distributed (single-process), but sufficient for single-instance
 * self-hosted mode. For multi-instance deployments behind a load balancer,
 * consider adding Redis-backed rate limiting.
 *
 * Two-tier rate limiting for auth endpoints:
 *   1. `burst`   : sliding window of N attempts / window per identifier.
 *   2. `lockout` : sliding window of M failures / window. Once exhausted,
 *      the identifier stays denied until enough failures roll off.
 */

export interface LimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

const ALWAYS_OK: LimitResult = {
  success: true,
  limit: Number.POSITIVE_INFINITY,
  remaining: Number.POSITIVE_INFINITY,
  reset: 0,
};

interface AuthLimiter {
  check(identifier: string): Promise<LimitResult>;
  recordFailure(identifier: string): Promise<void>;
}

declare global {
  var __irRateLimiters: Record<string, AuthLimiter> | undefined;
}

type Window = `${number} ${"s" | "m" | "h"}`;

type LimiterSpec =
  | {
      kind: "auth";
      burstCount: number;
      burstWindow: Window;
      lockoutCount: number;
      lockoutWindow: Window;
    }
  | {
      kind: "burst-only";
      burstCount: number;
      burstWindow: Window;
    };

const AUTH_SPEC: LimiterSpec = {
  kind: "auth",
  burstCount: 5,
  burstWindow: "60 s",
  lockoutCount: 10,
  lockoutWindow: "15 m",
};

class InMemoryRateLimiter {
  private windows = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowStr: string) {
    this.maxRequests = maxRequests;
    this.windowMs = this.parseWindow(windowStr);
  }

  private parseWindow(w: string): number {
    const match = w.match(/^(\d+)\s*(s|m|h)$/);
    if (!match) return 60_000;
    const n = parseInt(match[1]!, 10);
    switch (match[2]) {
      case "s": return n * 1000;
      case "m": return n * 60_000;
      case "h": return n * 3_600_000;
      default: return 60_000;
    }
  }

  check(identifier: string): LimitResult {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const entries = (this.windows.get(identifier) ?? []).filter(t => t > cutoff);
    this.windows.set(identifier, entries);

    if (entries.length >= this.maxRequests) {
      return {
        success: false,
        limit: this.maxRequests,
        remaining: 0,
        reset: entries[0]! + this.windowMs,
      };
    }

    entries.push(now);
    return {
      success: true,
      limit: this.maxRequests,
      remaining: this.maxRequests - entries.length,
      reset: now + this.windowMs,
    };
  }
}

const buildLimiter = (_prefix: string, spec: LimiterSpec): AuthLimiter => {
  const memLimiter = new InMemoryRateLimiter(spec.burstCount, spec.burstWindow);
  const lockoutLimiter = spec.kind === "auth"
    ? new InMemoryRateLimiter(spec.lockoutCount, spec.lockoutWindow)
    : null;

  return {
    check: async (identifier) => {
      if (lockoutLimiter) {
        const lockResult = lockoutLimiter.check(identifier);
        if (!lockResult.success) return lockResult;
      }
      return memLimiter.check(identifier);
    },
    recordFailure: async (identifier) => {
      lockoutLimiter?.check(identifier);
    },
  };
};

const limiters: Record<string, AuthLimiter> = isProduction
  ? {}
  : (globalThis.__irRateLimiters ??= {});

const getLimiter = (prefix: string, spec: LimiterSpec): AuthLimiter => {
  limiters[prefix] ??= buildLimiter(prefix, spec);
  return limiters[prefix];
};

export const signInLimiter = (): AuthLimiter => getLimiter("signin", AUTH_SPEC);
export const signUpLimiter = (): AuthLimiter => getLimiter("signup", AUTH_SPEC);
export const oauthLimiter = (): AuthLimiter => getLimiter("oauth", AUTH_SPEC);

export const resendVerificationLimiter = (): AuthLimiter =>
  getLimiter("resend-verification", {
    kind: "burst-only",
    burstCount: 5,
    burstWindow: "1 h",
  });

export const passwordResetRequestLimiter = (): AuthLimiter =>
  getLimiter("password-reset-request", {
    kind: "burst-only",
    burstCount: 5,
    burstWindow: "1 h",
  });

export const passwordResetCompleteLimiter = (): AuthLimiter =>
  getLimiter("password-reset-complete", {
    kind: "burst-only",
    burstCount: 10,
    burstWindow: "1 h",
  });

export const sessionCreateLimiter = (): AuthLimiter =>
  getLimiter("session-create", {
    kind: "burst-only",
    burstCount: 30,
    burstWindow: "1 h",
  });

export const audioLifecycleLimiter = (): AuthLimiter =>
  getLimiter("audio-lifecycle", {
    kind: "burst-only",
    burstCount: 60,
    burstWindow: "5 m",
  });

export const sessionPollLimiter = (): AuthLimiter =>
  getLimiter("session-poll", {
    kind: "burst-only",
    burstCount: 240,
    burstWindow: "1 m",
  });

export const sessionReviewWriteLimiter = (): AuthLimiter =>
  getLimiter("session-review-write", {
    kind: "burst-only",
    burstCount: 180,
    burstWindow: "5 m",
  });

export const checkoutCreateLimiter = (): AuthLimiter =>
  getLimiter("checkout-create", {
    kind: "burst-only",
    burstCount: 10,
    burstWindow: "5 m",
  });

export const analyzeRequestLimiter = (): AuthLimiter =>
  getLimiter("analyze-request", {
    kind: "burst-only",
    burstCount: 6,
    burstWindow: "5 m",
  });

export const sessionDeleteLimiter = (): AuthLimiter =>
  getLimiter("session-delete", {
    kind: "burst-only",
    burstCount: 30,
    burstWindow: "10 m",
  });

export const accountManagementLimiter = (): AuthLimiter =>
  getLimiter("account-management", {
    kind: "burst-only",
    burstCount: 30,
    burstWindow: "1 h",
  });

export const contactSubmitLimiter = (): AuthLimiter =>
  getLimiter("contact-submit", {
    kind: "burst-only",
    burstCount: 5,
    burstWindow: "1 h",
  });

export const profileWriteLimiter = (): AuthLimiter =>
  getLimiter("profile-write", {
    kind: "burst-only",
    burstCount: 240,
    burstWindow: "5 m",
  });

export const resumeParseLimiter = (): AuthLimiter =>
  getLimiter("resume-parse", {
    kind: "burst-only",
    burstCount: 10,
    burstWindow: "1 h",
  });

export const resumeParsePollLimiter = (): AuthLimiter =>
  getLimiter("resume-parse-poll", {
    kind: "burst-only",
    burstCount: 240,
    burstWindow: "1 m",
  });

export const outcomeWriteLimiter = (): AuthLimiter =>
  getLimiter("outcome-write", {
    kind: "burst-only",
    burstCount: 60,
    burstWindow: "5 m",
  });

export const feedbackWriteLimiter = (): AuthLimiter =>
  getLimiter("feedback-write", {
    kind: "burst-only",
    burstCount: 5,
    burstWindow: "1 h",
  });

export const rebuildWriteLimiter = (): AuthLimiter =>
  getLimiter("rebuild-write", {
    kind: "burst-only",
    burstCount: 240,
    burstWindow: "5 m",
  });

export const rebuildCritiqueLimiter = (): AuthLimiter =>
  getLimiter("rebuild-critique", {
    kind: "burst-only",
    burstCount: 12,
    burstWindow: "5 m",
  });

export const dataExportRequestLimiter = (): AuthLimiter =>
  getLimiter("data-export-request", {
    kind: "burst-only",
    burstCount: 5,
    burstWindow: "24 h",
  });

export const cspReportLimiter = (): AuthLimiter =>
  getLimiter("csp-report", {
    kind: "burst-only",
    burstCount: 60,
    burstWindow: "1 h",
  });

const PRIVATE_RANGES = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^127\./,
  /^169\.254\./,
  /^::1$/,
  /^fc/i,
  /^fd/i,
];

const looksPrivate = (ip: string): boolean =>
  PRIVATE_RANGES.some((re) => re.test(ip));

let warnedAboutMissingForwardedFor = false;
const warnMissingForwardedForOnce = (): void => {
  if (warnedAboutMissingForwardedFor) return;
  warnedAboutMissingForwardedFor = true;
  if (isProduction) {
    console.error(
      "[rate-limit] No usable client IP on a production request. Every " +
        "caller is sharing one rate-limit bucket. Configure your proxy/CDN " +
        "to forward the client IP and set TRUSTED_PROXY_HOPS to match.",
    );
  }
};

export const ipFromHeaders = (headers: Headers): string | null => {
  const { env } = require("@/lib/env");
  const hops = env.TRUSTED_PROXY_HOPS;

  if (!isProduction) {
    const xff = headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = headers.get("x-real-ip");
    if (real) return real;
    return "unknown-ip";
  }

  if (hops > 0) {
    const xff = headers.get("x-forwarded-for");
    if (xff) {
      const entries = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const idxFromEnd = hops;
      const candidate = entries[entries.length - 1 - (idxFromEnd - 1)];
      if (candidate && !looksPrivate(candidate)) return candidate;
    }
  }

  const real = headers.get("x-real-ip");
  if (real && !looksPrivate(real)) return real;

  warnMissingForwardedForOnce();
  return null;
};
