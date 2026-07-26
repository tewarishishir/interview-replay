/**
 * Unit tests for the client-side upload helper.
 *
 * The retry/backoff policy is the load-bearing piece — losing a
 * recording because we gave up after one transient flake would be
 * catastrophic UX. We verify:
 *   - First-try success doesn't sleep.
 *   - Transient failures retry with exponential backoff.
 *   - Final exhaustion surfaces the last error.
 *   - AbortSignal short-circuits.
 *
 * We swap `XMLHttpRequest` on `globalThis` for a controllable stub,
 * which is what the helper uses under the hood (because `fetch`
 * doesn't expose upload progress).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uploadAudio, UploadFailed } from "@/lib/recording/upload";

interface XHRStub {
  open: ReturnType<typeof vi.fn>;
  setRequestHeader: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  upload: { onprogress: ((e: ProgressEvent) => void) | null };
  onload: ((e?: Event) => void) | null;
  onerror: ((e?: Event) => void) | null;
  ontimeout: (() => void) | null;
  onabort: (() => void) | null;
  status: number;
  responseText: string;
}

const newXHR = (): XHRStub => ({
  open: vi.fn(),
  setRequestHeader: vi.fn(),
  send: vi.fn(),
  abort: vi.fn(),
  upload: { onprogress: null },
  onload: null,
  onerror: null,
  ontimeout: null,
  onabort: null,
  status: 0,
  responseText: "",
});

let xhrInstances: XHRStub[];

beforeEach(() => {
  xhrInstances = [];
  vi.useFakeTimers();
  // Replace XHR globally with our stub.
  (
    globalThis as unknown as { XMLHttpRequest: unknown }
  ).XMLHttpRequest = vi.fn(() => {
    const x = newXHR();
    xhrInstances.push(x);
    return x;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const BLOB = new Blob(["audio"], { type: "audio/webm" });

const completeWith = (xhr: XHRStub, status: number) => {
  xhr.status = status;
  xhr.onload?.();
};

describe("uploadAudio", () => {
  it("resolves on first 200 without sleeping", async () => {
    const promise = uploadAudio({
      url: "https://s3.test/upload",
      blob: BLOB,
      headers: { "Content-Type": "audio/webm" },
    });

    // `XMLHttpRequest` was constructed once.
    expect(xhrInstances).toHaveLength(1);
    completeWith(xhrInstances[0]!, 200);
    await promise;
  });

  it("retries up to 3 times on transient failures with exponential backoff", async () => {
    const onRetry = vi.fn();
    const promise = uploadAudio({
      url: "https://s3.test/upload",
      blob: BLOB,
      headers: { "Content-Type": "audio/webm" },
      retries: 3,
      baseDelayMs: 1000,
      onRetry,
    });

    // Attempt 1 fails. After invoking `onload` we need to flush the
    // promise microtasks so the `onRetry` callback inside the
    // helper's catch block actually runs before we assert on it.
    completeWith(xhrInstances[0]!, 500);
    await Promise.resolve();
    await Promise.resolve();
    expect(onRetry).toHaveBeenCalledWith(1, 1000, expect.any(Error));

    // Sleep 1s.
    await vi.advanceTimersByTimeAsync(1000);
    expect(xhrInstances).toHaveLength(2);

    // Attempt 2 fails.
    completeWith(xhrInstances[1]!, 500);
    await Promise.resolve();
    await Promise.resolve();
    expect(onRetry).toHaveBeenCalledWith(2, 2000, expect.any(Error));

    // Sleep 2s.
    await vi.advanceTimersByTimeAsync(2000);
    expect(xhrInstances).toHaveLength(3);

    // Attempt 3 succeeds.
    completeWith(xhrInstances[2]!, 200);
    await promise;
  });

  it("rejects with the final error after all retries exhausted", async () => {
    const promise = uploadAudio({
      url: "https://s3.test/upload",
      blob: BLOB,
      headers: { "Content-Type": "audio/webm" },
      retries: 2,
      baseDelayMs: 1,
    });

    // Attach the rejection handler synchronously so an unhandled
    // rejection between attempts doesn't fail the test runner.
    const settled = promise.catch((err) => err);

    completeWith(xhrInstances[0]!, 500);
    await vi.advanceTimersByTimeAsync(1);
    completeWith(xhrInstances[1]!, 500);
    await vi.advanceTimersByTimeAsync(2);
    completeWith(xhrInstances[2]!, 500);

    const err = await settled;
    expect(err).toBeInstanceOf(UploadFailed);
    expect((err as UploadFailed).status).toBe(500);
  });

  it("aborts immediately when the AbortSignal fires", async () => {
    const controller = new AbortController();
    const promise = uploadAudio({
      url: "https://s3.test/upload",
      blob: BLOB,
      headers: { "Content-Type": "audio/webm" },
      retries: 3,
      baseDelayMs: 1,
      signal: controller.signal,
    });
    const settled = promise.catch((err) => err);

    // Abort while the first attempt is in flight.
    controller.abort();
    xhrInstances[0]!.onabort?.();

    const err = await settled;
    expect(err).toBeInstanceOf(UploadFailed);
  });

  it("does NOT retry on a permanent 4xx response (regression)", async () => {
    // local storage returns 403 for a SignatureDoesNotMatch / expired URL —
    // those will return the same status no matter how many times we
    // try. Burning retries on them is wasted budget AND delays the
    // user from getting a fresh URL.
    const onRetry = vi.fn();
    const promise = uploadAudio({
      url: "https://s3.test/upload",
      blob: BLOB,
      headers: { "Content-Type": "audio/webm" },
      retries: 3,
      baseDelayMs: 1,
      onRetry,
    });
    const settled = promise.catch((err) => err);

    completeWith(xhrInstances[0]!, 403);
    await vi.advanceTimersByTimeAsync(1);

    const err = await settled;
    expect(err).toBeInstanceOf(UploadFailed);
    expect((err as UploadFailed).status).toBe(403);
    expect((err as UploadFailed).kind).toBe("permanent");
    expect(onRetry).not.toHaveBeenCalled();
    // Only one XHR attempt — no retries.
    expect(xhrInstances).toHaveLength(1);
  });

  it("times out an attempt that never completes (regression)", async () => {
    const promise = uploadAudio({
      url: "https://s3.test/upload",
      blob: BLOB,
      headers: { "Content-Type": "audio/webm" },
      retries: 0,
      timeoutMs: 5_000,
    });
    const settled = promise.catch((err) => err);

    // Don't call onload/onerror — simulate a stalled connection.
    // Walking the watchdog forward should reject with a timeout.
    await vi.advanceTimersByTimeAsync(5_000);

    const err = await settled;
    expect(err).toBeInstanceOf(UploadFailed);
    expect((err as UploadFailed).kind).toBe("timeout");
  });
});
