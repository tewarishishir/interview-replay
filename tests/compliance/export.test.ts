/**
 * Tests for the data-export helpers.
 *
 * - DB-side helpers (`enqueueExportRow`, `findInFlightExport`,
 *   `getLatestReadyExport`, `markExport*`, `findExpiredExports`,
 *   `collectUserDataForExport`) hit real Postgres.
 * - The ZIP builder (`buildExportZip`) is pure: we feed it a small
 *   dump and round-trip through JSZip to check filename layout.
 *
 * The local storage PUT/GET (`uploadExportZip` + `presignExportDownload`) are
 * NOT tested here because they're thin wrappers over the storage SDK;
 * the contracts they enforce (correct key shape, ContentType,
 * Metadata) are easier to assert in the job runner function's
 * integration test.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq } from "drizzle-orm";
import JSZip from "jszip";

import { db, schema } from "@/lib/db";
import {
  EXPORT_TTL_DAYS,
  EXPORT_TTL_MS,
  buildExportKey,
  buildExportZip,
  collectUserDataForExport,
  enqueueExportRow,
  EXPORT_MAX_BYTES,
  ExportTooLargeError,
  findExpiredExports,
  findInFlightExport,
  getLatestReadyExport,
  markExportBuilding,
  markExportExpired,
  markExportFailed,
  markExportReady,
} from "@/lib/compliance";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

const insertUser = async (email = "alice@example.com") => {
  const [user] = await db
    .insert(schema.users)
    .values({
      email,
      name: "Alice Example",
      passwordHash: "fake-argon2-hash",
    })
    .returning();
  if (!user) throw new Error("insertUser: no row returned");
  return user;
};

describe("buildExportKey", () => {
  it("produces exports/{userId}/{exportId}.zip", () => {
    expect(
      buildExportKey({ userId: "u-1", exportId: "e-2" }),
    ).toBe("exports/u-1/e-2.zip");
  });
});

describe("enqueueExportRow", () => {
  it("creates a pending row and returns its id with existed=false", async () => {
    const user = await insertUser();
    const result = await enqueueExportRow({ userId: user.id });
    expect(result.existed).toBe(false);

    const [row] = await db
      .select()
      .from(schema.dataExports)
      .where(eq(schema.dataExports.id, result.id));
    expect(row?.userId).toBe(user.id);
    expect(row?.status).toBe("pending");
    expect(row?.s3Key).toBeNull();
    expect(row?.expiresAt).toBeNull();
  });

  it("returns existed=true (with the in-flight row's id) when one is already pending", async () => {
    // The partial unique index `(user_id) WHERE status IN
    // ('pending', 'building')` guarantees this — the second INSERT
    // trips 23505 and we recover by looking up the existing row.
    const user = await insertUser();
    const first = await enqueueExportRow({ userId: user.id });
    expect(first.existed).toBe(false);

    const second = await enqueueExportRow({ userId: user.id });
    expect(second.existed).toBe(true);
    expect(second.id).toBe(first.id);

    // Exactly one row in the table (no orphan from the failed INSERT).
    const rows = await db
      .select()
      .from(schema.dataExports)
      .where(eq(schema.dataExports.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it("returns existed=true (same id) when a building row exists", async () => {
    const user = await insertUser();
    const first = await enqueueExportRow({ userId: user.id });
    await markExportBuilding(first.id);

    const second = await enqueueExportRow({ userId: user.id });
    expect(second.existed).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("creates a fresh row after the prior export hits a terminal state", async () => {
    // The partial unique index doesn't apply once status moves to
    // ready/failed/expired, so the same user can request a follow-up
    // export immediately. (No 7-day cooldown; rate-limiting lives in
    // a different layer.)
    const user = await insertUser();
    const first = await enqueueExportRow({ userId: user.id });
    await markExportFailed({ exportId: first.id, error: "boom" });

    const second = await enqueueExportRow({ userId: user.id });
    expect(second.existed).toBe(false);
    expect(second.id).not.toBe(first.id);
  });
});

describe("findInFlightExport", () => {
  it("returns the row when one is pending", async () => {
    const user = await insertUser();
    const { id } = await enqueueExportRow({ userId: user.id });

    const inflight = await findInFlightExport(user.id);
    expect(inflight?.id).toBe(id);
    expect(inflight?.status).toBe("pending");
  });

  it("returns the row when one is building", async () => {
    const user = await insertUser();
    const { id } = await enqueueExportRow({ userId: user.id });
    await markExportBuilding(id);

    const inflight = await findInFlightExport(user.id);
    expect(inflight?.id).toBe(id);
    expect(inflight?.status).toBe("building");
  });

  it("returns null when only ready/failed/expired rows exist", async () => {
    const user = await insertUser();

    const { id: ready } = await enqueueExportRow({ userId: user.id });
    await markExportReady({
      exportId: ready,
      s3Key: buildExportKey({ userId: user.id, exportId: ready }),
      fileSizeBytes: 100,
    });

    const { id: failed } = await enqueueExportRow({ userId: user.id });
    await markExportFailed({ exportId: failed, error: "boom" });

    const inflight = await findInFlightExport(user.id);
    expect(inflight).toBeNull();
  });

  it("does not leak another user's in-flight export", async () => {
    const a = await insertUser("a@example.com");
    const b = await insertUser("b@example.com");
    await enqueueExportRow({ userId: a.id });

    const inflight = await findInFlightExport(b.id);
    expect(inflight).toBeNull();
  });
});

describe("markExportReady", () => {
  it("stamps status=ready, s3Key, completedAt, and expiresAt at +TTL", async () => {
    const user = await insertUser();
    const { id } = await enqueueExportRow({ userId: user.id });
    const now = new Date("2026-05-01T00:00:00Z");

    const { expiresAt } = await markExportReady({
      exportId: id,
      s3Key: "exports/u/e.zip",
      fileSizeBytes: 4242,
      now,
    });

    expect(expiresAt.getTime()).toBe(now.getTime() + EXPORT_TTL_MS);

    const [row] = await db
      .select()
      .from(schema.dataExports)
      .where(eq(schema.dataExports.id, id));

    expect(row?.status).toBe("ready");
    expect(row?.s3Key).toBe("exports/u/e.zip");
    expect(row?.fileSizeBytes).toBe(4242);
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(row?.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
  });
});

describe("markExportFailed", () => {
  it("stamps status=failed and the error message", async () => {
    const user = await insertUser();
    const { id } = await enqueueExportRow({ userId: user.id });
    await markExportFailed({ exportId: id, error: "local storage timeout" });

    const [row] = await db
      .select()
      .from(schema.dataExports)
      .where(eq(schema.dataExports.id, id));

    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("local storage timeout");
    expect(row?.completedAt).toBeInstanceOf(Date);
  });
});

describe("getLatestReadyExport", () => {
  it("returns the latest non-expired ready export for the user", async () => {
    const user = await insertUser();

    // Older ready, still fresh.
    const { id: older } = await enqueueExportRow({ userId: user.id });
    const olderTime = new Date(Date.now() - 60 * 60_000);
    await markExportReady({
      exportId: older,
      s3Key: "exports/u/older.zip",
      fileSizeBytes: 1,
      now: olderTime,
    });

    // Newer ready, fresh.
    const { id: newer } = await enqueueExportRow({ userId: user.id });
    await markExportReady({
      exportId: newer,
      s3Key: "exports/u/newer.zip",
      fileSizeBytes: 2,
    });

    const latest = await getLatestReadyExport(user.id);
    expect(latest?.id).toBe(newer);
    expect(latest?.s3Key).toBe("exports/u/newer.zip");
  });

  it("ignores rows whose TTL has passed", async () => {
    const user = await insertUser();
    const { id } = await enqueueExportRow({ userId: user.id });

    // Stamp ready with a back-dated `now` so expiresAt is in the past.
    const ancient = new Date(Date.now() - EXPORT_TTL_MS - 60_000);
    await markExportReady({
      exportId: id,
      s3Key: "exports/u/old.zip",
      fileSizeBytes: 1,
      now: ancient,
    });

    const latest = await getLatestReadyExport(user.id);
    expect(latest).toBeNull();
  });

  it("returns null when only pending rows exist", async () => {
    const user = await insertUser();
    await enqueueExportRow({ userId: user.id });
    expect(await getLatestReadyExport(user.id)).toBeNull();
  });
});

describe("findExpiredExports / markExportExpired", () => {
  it("finds ready rows whose expiresAt has passed", async () => {
    const user = await insertUser();

    // Fresh ready: not expired.
    const { id: fresh } = await enqueueExportRow({ userId: user.id });
    await markExportReady({
      exportId: fresh,
      s3Key: "exports/u/fresh.zip",
      fileSizeBytes: 1,
    });

    // Stale ready: expired.
    const { id: stale } = await enqueueExportRow({ userId: user.id });
    const ancient = new Date(Date.now() - EXPORT_TTL_MS - 60_000);
    await markExportReady({
      exportId: stale,
      s3Key: "exports/u/stale.zip",
      fileSizeBytes: 1,
      now: ancient,
    });

    const expired = await findExpiredExports();
    const ids = expired.map((e) => e.id);
    expect(ids).toContain(stale);
    expect(ids).not.toContain(fresh);
  });

  it("flips a row to status=expired", async () => {
    const user = await insertUser();
    const { id } = await enqueueExportRow({ userId: user.id });
    const ancient = new Date(Date.now() - EXPORT_TTL_MS - 60_000);
    await markExportReady({
      exportId: id,
      s3Key: "exports/u/x.zip",
      fileSizeBytes: 1,
      now: ancient,
    });

    await markExportExpired(id);

    const [row] = await db
      .select()
      .from(schema.dataExports)
      .where(eq(schema.dataExports.id, id));
    expect(row?.status).toBe("expired");
  });
});

describe("collectUserDataForExport", () => {
  it("returns just the profile when no sessions exist", async () => {
    const user = await insertUser("solo@example.com");
    const dump = await collectUserDataForExport(user.id);

    expect(dump.profile).toMatchObject({
      id: user.id,
      email: "solo@example.com",
    });
    expect(dump.sessions).toEqual([]);
    expect(dump.transcripts).toEqual([]);
    expect(dump.artifacts).toEqual([]);
    expect(dump.reports).toEqual([]);
    expect(dump.audioFiles).toEqual([]);
    expect(dump.outcomes).toEqual([]);
    expect(dump.rebuilds).toEqual([]);
    expect(typeof dump.exportedAt).toBe("string");
  });

  it("includes sessions + transcripts + reports owned by the user", async () => {
    const user = await insertUser();
    const [session] = await db
      .insert(schema.interviewSessions)
      .values({
        userId: user.id,
        companyName: "Acme",
        roleTitle: "Engineer",
        level: "senior",
        roundType: "coding",
        consentAffirmedAt: new Date(),
      })
      .returning();
    if (!session) throw new Error("setup failed");

    await db.insert(schema.transcripts).values({
      sessionId: session.id,
      rawText: "hello",
      redactedText: "hello",
      wordCount: 1,
      durationSeconds: 5,
      fillerWordCount: 0,
    });
    await db.insert(schema.artifacts).values({
      sessionId: session.id,
      artifactType: "code",
      content: "int main(){}",
    });
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { score: 4 },
      modelVersion: "v1",
      rubricVersion: "r1",
    });

    const dump = await collectUserDataForExport(user.id);

    expect(dump.sessions).toHaveLength(1);
    expect(dump.transcripts).toHaveLength(1);
    expect(dump.artifacts).toHaveLength(1);
    expect(dump.reports).toHaveLength(1);
  });

  it("does NOT leak another user's data", async () => {
    const me = await insertUser("me@example.com");
    const them = await insertUser("them@example.com");
    await db.insert(schema.interviewSessions).values({
      userId: them.id,
      companyName: "Acme",
      roleTitle: "Engineer",
      level: "senior",
      roundType: "coding",
      consentAffirmedAt: new Date(),
    });

    const dump = await collectUserDataForExport(me.id);
    expect(dump.sessions).toEqual([]);
  });

  it("throws when the user does not exist", async () => {
    await expect(
      collectUserDataForExport("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/not found/);
  });
});

describe("buildExportZip", () => {
  it("emits one JSON per category + a README", async () => {
    const dump = {
      profile: { id: "u-1", email: "alice@example.com" },
      sessions: [{ id: "s-1" }],
      transcripts: [],
      artifacts: [],
      reports: [],
      audioFiles: [],
      outcomes: [],
      rebuilds: [],
      exportedAt: "2026-05-01T00:00:00.000Z",
    };

    const bytes = await buildExportZip(dump);
    expect(bytes.byteLength).toBeGreaterThan(0);

    // Round-trip the ZIP through JSZip to check what it contains.
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).sort();

    expect(names).toEqual(
      [
        "README.txt",
        "artifacts.json",
        "audio_files.json",
        "outcomes.json",
        "profile.json",
        "rebuilds.json",
        "reports.json",
        "sessions.json",
        "transcripts.json",
      ].sort(),
    );

    const profile = JSON.parse(
      await zip.file("profile.json")!.async("string"),
    );
    expect(profile).toEqual(dump.profile);

    const readme = await zip.file("README.txt")!.async("string");
    expect(readme).toContain("InterviewReplay data export");
    expect(readme).toContain("2026-05-01T00:00:00.000Z");
    expect(readme).toContain("privacy@example.com");
  });

  it("throws ExportTooLargeError when the compressed body exceeds maxBytes", async () => {
    // Use the injectable `maxBytes` to avoid allocating 100+ MB of
    // incompressible bytes in the test harness. The production cap
    // (EXPORT_MAX_BYTES) is exercised end-to-end by the worker
    // tests; here we just verify the guard fires when triggered.
    const dump = {
      profile: { id: "u-1", email: "x@example.com" },
      sessions: [],
      transcripts: [],
      artifacts: [],
      reports: [],
      audioFiles: [],
      outcomes: [],
      rebuilds: [],
      exportedAt: "2026-05-01T00:00:00.000Z",
    };

    // The README + 10 empty JSON files alone are >100 bytes once
    // ZIP overhead is added. Setting the cap to 50 bytes guarantees
    // the guard trips.
    await expect(
      buildExportZip(dump, { maxBytes: 50 }),
    ).rejects.toBeInstanceOf(ExportTooLargeError);

    // Verify the error carries the diagnostic fields the worker
    // logs into `dataExports.error`.
    try {
      await buildExportZip(dump, { maxBytes: 50 });
    } catch (err) {
      expect(err).toBeInstanceOf(ExportTooLargeError);
      const e = err as ExportTooLargeError;
      expect(e.bytes).toBeGreaterThan(50);
      expect(e.limit).toBe(50);
    }
  });

  it("EXPORT_MAX_BYTES is exposed for the worker to compare against", () => {
    expect(typeof EXPORT_MAX_BYTES).toBe("number");
    expect(EXPORT_MAX_BYTES).toBeGreaterThan(0);
  });
});

describe("constants sanity", () => {
  it("EXPORT_TTL_DAYS = 7 (per PRD)", () => {
    expect(EXPORT_TTL_DAYS).toBe(7);
  });
});
