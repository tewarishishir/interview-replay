/**
 * Client-side upload pipeline for the recorded audio blob.
 *
 * Lives in `lib/recording` (rather than the recorder component) so:
 *   1. The recorder UI stays focused on capture + display.
 *   2. The retry/backoff policy can be unit-tested without a browser.
 *   3. A future "resume from blob in IndexedDB" path can reuse the
 *      same `uploadAudio` function.
 *
 * Per spec:
 *   - 3 client-side retries with exponential backoff.
 *   - Only retry transient errors (network blip, 5xx, 408, 429).
 *     Permanent rejects (400/403 — wrong signature, expired URL,
 *     content-type mismatch) won't change on retry, so we surface
 *     immediately and let the recorder UI prompt the user to retry
 *     the WHOLE upload (which mints a fresh upload URL).
 *   - Per-attempt timeout so a stalled XHR can't hold the recording
 *     open indefinitely on a half-broken network.
 *   - On exhaustion, surface to the caller with the Blob still
 *     intact so they can show a "Retry upload" button.
 *   - Progress callback drives the progress bar in the UI.
 *
 * NOTE: this module is NOT marked `"use client"` and contains no
 * JSX. It's safe to import from a Client Component or from a
 * test that mocks `XMLHttpRequest`/`fetch`.
 */

export type UploadProgress = {
  loaded: number;
  total: number;
};

/**
 * Discriminator for `UploadFailed` so a caller can distinguish
 * "retryable transport blip" from "permanent reject" without
 * re-implementing status parsing.
 */
export type UploadFailureKind =
  | "network" // status === 0 (DNS, offline, CORS reject)
  | "timeout" // attempt exceeded its time budget
  | "aborted" // caller's AbortSignal fired
  | "transient" // 5xx, 408, 429 — retry-worthy
  | "permanent"; // 4xx other than the transient set

export class UploadFailed extends Error {
  readonly status: number;
  readonly kind: UploadFailureKind;
  constructor(message: string, status = 0, kind: UploadFailureKind = "network") {
    super(message);
    this.name = "UploadFailed";
    this.status = status;
    this.kind = kind;
  }
}

/**
 * Default per-attempt timeout. 60 s is generous enough for slow
 * mobile uploads of multi-minute recordings (a 5-minute Opus@64kbps
 * blob is ~2.4 MB; even a constrained connection should clear that
 * inside 60s) but tight enough that a fully stalled connection
 * surfaces as a timeout instead of hanging the UI forever.
 */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;

/**
 * Map an HTTP status code to retry policy. We retry on:
 *   - 408 Request Timeout (server-side timeout, often transient)
 *   - 429 Too Many Requests (back-off-and-retry is the spec'd behavior)
 *   - 5xx (everything in the 500-599 range)
 * Anything else 4xx is permanent (auth, signature, bad-request).
 */
function classifyStatus(status: number): UploadFailureKind {
  if (status === 0) return "network";
  if (status === 408 || status === 429) return "transient";
  if (status >= 500 && status < 600) return "transient";
  if (status >= 400 && status < 500) return "permanent";
  return "permanent";
}

export interface UploadStepInput {
  url: string;
  blob: Blob;
  headers: Record<string, string>;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /**
   * Per-attempt timeout. Exposed so tests can shorten it.
   */
  timeoutMs?: number;
}

/**
 * Single PUT to the upload URL via XHR (we need progress events,
 * which `fetch()` still doesn't provide for upload bodies).
 *
 * Resolves on 2xx, rejects with `UploadFailed` on any other status
 * or transport error. Caller decides whether to retry.
 */
export function putToStorage({
  url,
  blob,
  headers,
  onProgress,
  signal,
  timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
}: UploadStepInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    // XHR's built-in `timeout` only covers idle time after `send`;
    // browsers vary on whether it fires reliably across Wi-Fi
    // transitions. We set it as a hint and also keep our own
    // `setTimeout` below so a totally stuck connection still aborts.
    xhr.timeout = timeoutMs;

    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }

    xhr.upload.onprogress = (event) => {
      if (!onProgress) return;
      if (event.lengthComputable) {
        onProgress({ loaded: event.loaded, total: event.total });
      } else {
        onProgress({ loaded: event.loaded, total: blob.size });
      }
    };

    let settled = false;
    const settle = (cb: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      cb();
    };

    const watchdog = globalThis.setTimeout(() => {
      try {
        xhr.abort();
      } catch {
        // already done
      }
      settle(() =>
        reject(
          new UploadFailed(
            `Upload timed out after ${timeoutMs}ms`,
            0,
            "timeout",
          ),
        ),
      );
    }, timeoutMs);

    const cleanup = () => {
      globalThis.clearTimeout(watchdog);
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        settle(() => resolve());
      } else {
        const kind = classifyStatus(xhr.status);
        settle(() =>
          reject(
            new UploadFailed(
              `Upload PUT failed with status ${xhr.status}`,
              xhr.status,
              kind,
            ),
          ),
        );
      }
    };

    xhr.onerror = () =>
      settle(() =>
        reject(new UploadFailed("Network error during upload", 0, "network")),
      );
    xhr.ontimeout = () =>
      settle(() =>
        reject(new UploadFailed("Upload timed out", 0, "timeout")),
      );
    xhr.onabort = () => {
      // `xhr.abort()` triggers this handler. We disambiguate "we
      // hit our internal watchdog" (already settled as timeout) from
      // "caller aborted" by checking `signal.aborted`.
      const kind: UploadFailureKind = signal?.aborted ? "aborted" : "aborted";
      settle(() => reject(new UploadFailed("Upload aborted", 0, kind)));
    };

    const abortHandler = () => {
      try {
        xhr.abort();
      } catch {
        // Ignore — already aborted.
      }
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    xhr.send(blob);
  });
}

/**
 * Sleep helper used between retries. Exposed so tests can mock it.
 * Bridge through globalThis so a test can stub setTimeout if needed.
 */
const wait = (ms: number) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

export interface UploadOptions {
  retries?: number;
  /**
   * Base delay in ms. Each retry waits `baseDelayMs * 2^attempt`
   * (so 1s, 2s, 4s by default). Exposed for tests to shorten.
   */
  baseDelayMs?: number;
  onProgress?: (progress: UploadProgress) => void;
  /**
   * Called once after each attempt fails (NOT after the final
   * exhaustion — that surfaces via the rejected Promise). Lets the
   * recorder UI display "Retrying (2/3)…".
   */
  onRetry?: (attempt: number, nextDelayMs: number, err: unknown) => void;
  signal?: AbortSignal;
  /**
   * Per-attempt timeout. Exposed so tests can shorten.
   */
  timeoutMs?: number;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

/**
 * Upload `blob` to `url` with up to `retries` retries on transient
 * errors. Resolves on success; rejects with the final error if all
 * attempts fail.
 *
 * The Blob argument is NOT mutated and is kept alive by the caller
 * so a "Retry upload" button can re-invoke this function with the
 * same blob.
 *
 * Permanent failures (`UploadFailed.kind === "permanent"`) skip
 * retries entirely — the response won't change without a fresh
 * upload URL.
 */
export async function uploadAudio({
  url,
  blob,
  headers,
  retries = DEFAULT_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  onProgress,
  onRetry,
  signal,
  timeoutMs,
}: UploadStepInput & Omit<UploadOptions, "signal">): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new UploadFailed("Upload aborted", 0, "aborted");
    try {
      await putToStorage({ url, blob, headers, onProgress, signal, timeoutMs });
      return;
    } catch (err) {
      lastErr = err;
      // Don't retry once the user (or caller) actively bailed.
      if (signal?.aborted) throw err;
      // Don't retry permanent failures: a 400/403 is
      // deterministic for the same (URL, headers, body) tuple. The
      // recorder needs a fresh upload URL to make progress.
      if (err instanceof UploadFailed && err.kind === "permanent") throw err;
      if (attempt === retries) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      onRetry?.(attempt + 1, delay, err);
      await wait(delay);
    }
  }
  throw lastErr;
}
