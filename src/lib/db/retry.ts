import "server-only";

/**
 * In-process retry for transient Postgres connection errors.
 *
 * Wraps a DB operation and retries ONLY on transient connection
 * failures (network blips, connection pool exhaustion, server
 * restarts). Real SQL errors (constraint violations, syntax, etc.)
 * are re-thrown immediately.
 *
 * Default profile (5 attempts, 2s base, 2× growth, 12s cap):
 *   attempt 1: immediate
 *   wait ≈ 1–3 s
 *   attempt 2
 *   wait ≈ 2–6 s
 *   attempt 3
 *   wait ≈ 4–12 s  (capped)
 *   attempt 4
 *   wait ≈ 4–12 s  (capped)
 *   attempt 5 — last chance
 */

/** SQLSTATE codes that indicate a transient connection/availability fault. */
const TRANSIENT_PG_CODES = new Set<string>([
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08007", // transaction_resolution_unknown
]);

/** Substrings (lower-cased) that mark a transient transport/network fault. */
const TRANSIENT_MESSAGE_FRAGMENTS = [
  "connection terminated",
  "terminating connection",
  "connection closed",
  "connection reset",
  "connection refused",
  "econnreset",
  "econnrefused",
  "etimedout",
  "enotfound",
  "eai_again",
  "epipe",
  "socket hang up",
  "fetch failed",
  "network error",
  "timeout exceeded",
  "client has encountered a connection error",
  "the database connection is closing",
  "server closed the connection unexpectedly",
];

function isTransientConnectionError(err: unknown, depth = 0): boolean {
  if (err == null || depth > 8) return false;

  if (typeof err === "object") {
    const e = err as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
      cause?: unknown;
    };

    if (typeof e.code === "string" && TRANSIENT_PG_CODES.has(e.code)) {
      return true;
    }

    const msgRaw =
      typeof e.message === "string"
        ? e.message
        : (e as { stack?: unknown }).stack != null
          ? ""
          : String(err);
    const haystack =
      `${typeof e.name === "string" ? e.name : ""} ${msgRaw}`.toLowerCase();
    if (TRANSIENT_MESSAGE_FRAGMENTS.some((frag) => haystack.includes(frag))) {
      return true;
    }

    if (e.cause != null && e.cause !== err) {
      if (isTransientConnectionError(e.cause, depth + 1)) return true;
    }
  }

  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DbRetryOptions {
  /** Total attempts including the first. Default 5. */
  maxAttempts?: number;
  /** Base backoff in ms; grows 2× per attempt with jitter. Default 2000. */
  baseDelayMs?: number;
  /** Hard ceiling on any single sleep in ms. Default 12000. */
  maxDelayMs?: number;
  /** Label for the warn log emitted on each retry. */
  label?: string;
}

/**
 * Run `operation`, retrying it on transient Postgres connection errors.
 *
 * Safe to wrap idempotent reads and idempotent write transactions.
 * Do NOT wrap a non-idempotent multi-statement operation that could
 * double-apply if the failure happened after a partial commit.
 */
export async function withDbRetry<T>(
  operation: () => Promise<T>,
  options: DbRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const maxDelayMs = options.maxDelayMs ?? 12000;
  const label = options.label ?? "db";

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const transient = isTransientConnectionError(err);
      if (!transient || attempt === maxAttempts) {
        throw err;
      }
      const raw = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      const backoff = Math.min(raw, maxDelayMs);
      console.warn(
        `[withDbRetry:${label}] transient DB error on attempt ` +
          `${attempt}/${maxAttempts}; retrying in ${Math.round(backoff)}ms. ` +
          `Cause: ${flattenErrorChain(err)}`,
      );
      await sleep(backoff);
    }
  }

  throw lastError;
}

function flattenErrorChain(err: unknown, depth = 0): string {
  if (err == null || depth > 4) return "";
  const e = err as {
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const name = typeof e.name === "string" ? e.name : "Error";
  const msg = typeof e.message === "string" ? e.message : String(err);
  const head = `${name}: ${msg}`;
  const next = e.cause;
  if (next != null && next !== err) {
    const rest = flattenErrorChain(next, depth + 1);
    return rest ? `${head} ← ${rest}` : head;
  }
  return head;
}
