import { describe, expect, it, vi } from "vitest";

import { withDbRetry } from "@/lib/db/retry";

/**
 * Unit tests for the transient-connection retry wrapper. No DB is
 * touched — the "operation" is a plain mock so we can assert on retry
 * vs. immediate-throw behavior deterministically.
 */
describe("withDbRetry", () => {
  it("returns the result without retrying on success", async () => {
    const op = vi.fn().mockResolvedValue(42);
    const result = await withDbRetry(op, { baseDelayMs: 0 });
    expect(result).toBe(42);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries a transient connection error and then succeeds", async () => {
    const transient = Object.assign(new Error("Connection terminated unexpectedly"), {
      name: "PostgresDbError",
    });
    const op = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValue("ok");
    const result = await withDbRetry(op, { baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("detects a transient error nested in the Drizzle `cause` chain", async () => {
    // Mirrors how Drizzle wraps the driver error: the wrapper message
    // is the harmless "Failed query: …" string and the real fault is
    // a connection error on `.cause`.
    const driverError = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
    });
    const wrapped = Object.assign(
      new Error('Failed query: select count(*)::int from "audio_files" …'),
      { cause: driverError },
    );
    const op = vi.fn().mockRejectedValueOnce(wrapped).mockResolvedValue(0);
    const result = await withDbRetry(op, { baseDelayMs: 0 });
    expect(result).toBe(0);
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("retries on a transient SQLSTATE connection code", async () => {
    const err = Object.assign(new Error("cannot connect now"), {
      code: "57P03",
    });
    const op = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("woke");
    const result = await withDbRetry(op, { baseDelayMs: 0 });
    expect(result).toBe("woke");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a real SQL error (constraint violation)", async () => {
    const err = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
    });
    const op = vi.fn().mockRejectedValue(err);
    await expect(withDbRetry(op, { baseDelayMs: 0 })).rejects.toThrow(
      /duplicate key/,
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and rethrows the last transient error", async () => {
    const err = Object.assign(new Error("ECONNRESET"), { code: "08006" });
    const op = vi.fn().mockRejectedValue(err);
    await expect(
      withDbRetry(op, { baseDelayMs: 0, maxAttempts: 3, maxDelayMs: 0 }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("walks .sourceError (Postgres's network error wrapper) as transient", async () => {
    const networkErr = Object.assign(new Error("fetch failed"), {
      name: "TypeError",
    });
    const neonErr = Object.assign(new Error("Error connecting to database: fetch failed"), {
      name: "PostgresDbError",
      sourceError: networkErr,
    });
    const op = vi.fn().mockRejectedValueOnce(neonErr).mockResolvedValue("ok");
    const result = await withDbRetry(op, { baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });
});
