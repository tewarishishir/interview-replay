/**
 * Tests for the account-deletion lifecycle helpers.
 *
 * These hit a real local Postgres because the things we want to
 * verify (idempotent grace clock, FK cascade behavior, audit-log
 * anonymization) live in the DB layer, not in the orchestration code.
 *
 * The job runner cron + email side effects are wired up in the runtime
 * but tested separately from the pure DB helpers in here.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  ACCOUNT_DELETION_GRACE_MS,
  collectUserHardDeleteKeys,
  describeDeletionState,
  findExpiredDeletions,
  getPendingDeletion,
  hardDeleteUserRecord,
  initiateAccountDeletion,
  restoreAccount,
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

/**
 * Stamp a user's `deletion_requested_at` to a moment past the
 * 30-day grace window so `hardDeleteUserRecord` will accept it.
 * Mirrors the cron's mental model: by the time we're hard-deleting,
 * the request has been on the books for at least 30 days.
 */
const expireDeletion = async (userId: string) => {
  const expired = new Date(Date.now() - ACCOUNT_DELETION_GRACE_MS - 60_000);
  await db
    .update(schema.users)
    .set({ deletedAt: expired, deletionRequestedAt: expired })
    .where(eq(schema.users.id, userId));
};

describe("describeDeletionState", () => {
  it("active account → pending=false, no clock", () => {
    const state = describeDeletionState({
      deletedAt: null,
      deletionRequestedAt: null,
    });
    expect(state).toEqual({
      pending: false,
      requestedAt: null,
      hardDeleteAt: null,
      expired: false,
    });
  });

  it("pending within grace window → pending=true, expired=false", () => {
    const requestedAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-15T00:00:00Z");
    const state = describeDeletionState({
      deletedAt: requestedAt,
      deletionRequestedAt: requestedAt,
      now,
    });
    expect(state.pending).toBe(true);
    expect(state.expired).toBe(false);
    expect(state.hardDeleteAt?.toISOString()).toBe(
      new Date(requestedAt.getTime() + ACCOUNT_DELETION_GRACE_MS).toISOString(),
    );
  });

  it("past grace window → expired=true", () => {
    const requestedAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date(
      requestedAt.getTime() + ACCOUNT_DELETION_GRACE_MS + 1_000,
    );
    const state = describeDeletionState({
      deletedAt: requestedAt,
      deletionRequestedAt: requestedAt,
      now,
    });
    expect(state.pending).toBe(true);
    expect(state.expired).toBe(true);
  });
});

describe("initiateAccountDeletion", () => {
  it("stamps deleted_at + deletion_requested_at on the user row", async () => {
    const user = await insertUser();

    const result = await initiateAccountDeletion({ userId: user.id });

    expect(result.alreadyPending).toBe(false);
    expect(result.hardDeleteAt).toBeInstanceOf(Date);

    const [row] = await db
      .select({
        deletedAt: schema.users.deletedAt,
        deletionRequestedAt: schema.users.deletionRequestedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));

    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.deletionRequestedAt).toBeInstanceOf(Date);
  });

  it("writes an account.deletion.initiated audit row", async () => {
    const user = await insertUser();
    await initiateAccountDeletion({
      userId: user.id,
      ipAddress: "203.0.113.5",
      userAgent: "Mozilla/5.0 (vitest)",
    });

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));

    expect(audit).toHaveLength(1);
    expect(audit[0]?.eventType).toBe("account.deletion.initiated");
    expect(audit[0]?.ipAddress).toBe("203.0.113.5");
    const eventData = audit[0]?.eventData as { graceDays?: number } | null;
    expect(eventData?.graceDays).toBe(ACCOUNT_DELETION_GRACE_DAYS);
  });

  it("is idempotent — second call does NOT reset the clock", async () => {
    const user = await insertUser();

    const first = await initiateAccountDeletion({ userId: user.id });
    // Sleep just enough to make wall-clock timestamps differ if we
    // accidentally re-stamped on the second call.
    await new Promise((r) => setTimeout(r, 25));
    const second = await initiateAccountDeletion({ userId: user.id });

    expect(second.alreadyPending).toBe(true);
    expect(second.hardDeleteAt.toISOString()).toBe(
      first.hardDeleteAt.toISOString(),
    );

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));
    // Only the FIRST initiation writes audit: re-clicking the
    // delete button shouldn't spam the log.
    expect(audit).toHaveLength(1);
  });

  it("throws when the user does not exist", async () => {
    await expect(
      initiateAccountDeletion({
        userId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("restoreAccount", () => {
  it("clears deletion timestamps within grace window", async () => {
    const user = await insertUser();
    await initiateAccountDeletion({ userId: user.id });

    const result = await restoreAccount({ userId: user.id });
    expect(result.ok).toBe(true);

    const [row] = await db
      .select({
        deletedAt: schema.users.deletedAt,
        deletionRequestedAt: schema.users.deletionRequestedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));

    expect(row?.deletedAt).toBeNull();
    expect(row?.deletionRequestedAt).toBeNull();
  });

  it("writes an account.deletion.cancelled audit row", async () => {
    const user = await insertUser();
    await initiateAccountDeletion({ userId: user.id });
    await restoreAccount({ userId: user.id, ipAddress: "203.0.113.6" });

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, user.id));

    const cancelled = audit.find(
      (a) => a.eventType === "account.deletion.cancelled",
    );
    expect(cancelled).toBeDefined();
    expect(cancelled?.ipAddress).toBe("203.0.113.6");
  });

  it("returns not_pending when the account is active", async () => {
    const user = await insertUser();
    const result = await restoreAccount({ userId: user.id });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.reason : null).toBe("not_pending");
  });

  it("returns expired past the grace window", async () => {
    const user = await insertUser();
    // Manually back-date the request past the cutoff.
    const longAgo = new Date(Date.now() - ACCOUNT_DELETION_GRACE_MS - 60_000);
    await db
      .update(schema.users)
      .set({ deletedAt: longAgo, deletionRequestedAt: longAgo })
      .where(eq(schema.users.id, user.id));

    const result = await restoreAccount({ userId: user.id });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.reason : null).toBe("expired");
  });

  it("returns user_missing for an unknown user", async () => {
    const result = await restoreAccount({
      userId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.reason : null).toBe("user_missing");
  });
});

describe("findExpiredDeletions", () => {
  it("returns only users whose grace window has elapsed", async () => {
    const fresh = await insertUser("fresh@example.com");
    const stale = await insertUser("stale@example.com");

    // Fresh: just now; should NOT be returned.
    await initiateAccountDeletion({ userId: fresh.id });

    // Stale: back-date past cutoff.
    await initiateAccountDeletion({ userId: stale.id });
    const longAgo = new Date(Date.now() - ACCOUNT_DELETION_GRACE_MS - 60_000);
    await db
      .update(schema.users)
      .set({ deletedAt: longAgo, deletionRequestedAt: longAgo })
      .where(eq(schema.users.id, stale.id));

    const expired = await findExpiredDeletions();
    expect(expired.map((r) => r.userId)).toEqual([stale.id]);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 3; i++) {
      const u = await insertUser(`u${i}@example.com`);
      await initiateAccountDeletion({ userId: u.id });
      const longAgo = new Date(
        Date.now() - ACCOUNT_DELETION_GRACE_MS - 60_000,
      );
      await db
        .update(schema.users)
        .set({ deletedAt: longAgo, deletionRequestedAt: longAgo })
        .where(eq(schema.users.id, u.id));
    }

    const rows = await findExpiredDeletions({ limit: 2 });
    expect(rows).toHaveLength(2);
  });
});

describe("getPendingDeletion", () => {
  it("returns the timestamp inside the grace window", async () => {
    const user = await insertUser();
    await initiateAccountDeletion({ userId: user.id });

    const pending = await getPendingDeletion(user.id);
    expect(pending?.deletionRequestedAt).toBeInstanceOf(Date);
  });

  it("returns null past the grace window", async () => {
    const user = await insertUser();
    await initiateAccountDeletion({ userId: user.id });

    const longAgo = new Date(Date.now() - ACCOUNT_DELETION_GRACE_MS - 60_000);
    await db
      .update(schema.users)
      .set({ deletedAt: longAgo, deletionRequestedAt: longAgo })
      .where(eq(schema.users.id, user.id));

    const pending = await getPendingDeletion(user.id);
    expect(pending).toBeNull();
  });

  it("returns null on an active account", async () => {
    const user = await insertUser();
    const pending = await getPendingDeletion(user.id);
    expect(pending).toBeNull();
  });
});

describe("hardDeleteUserRecord", () => {
  it("removes the user row and cascades child rows", async () => {
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
      rawText: "hi",
      redactedText: "hi",
      wordCount: 1,
      durationSeconds: 10,
      fillerWordCount: 0,
    });
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { score: 4 },
      modelVersion: "v1",
      rubricVersion: "r1",
    });

    await expireDeletion(user.id);
    const result = await hardDeleteUserRecord({ userId: user.id });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.userId).toBe(user.id);

    const remainingUsers = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(remainingUsers).toHaveLength(0);

    const remainingSessions = await db
      .select()
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(remainingSessions).toHaveLength(0);

    const remainingTranscripts = await db
      .select()
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, session.id));
    expect(remainingTranscripts).toHaveLength(0);

    const remainingReports = await db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, session.id));
    expect(remainingReports).toHaveLength(0);
  });

  it("anonymizes audit_log instead of deleting (regulatory)", async () => {
    const user = await insertUser();
    await db.insert(schema.auditLog).values({
      userId: user.id,
      eventType: "account.signup",
      eventData: { source: "test" },
    });
    await initiateAccountDeletion({ userId: user.id });

    await expireDeletion(user.id);
    const result = await hardDeleteUserRecord({ userId: user.id });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.auditLogAnonymized).toBeGreaterThan(0);

    const orphans = await db
      .select()
      .from(schema.auditLog)
      .where(isNull(schema.auditLog.userId));
    expect(orphans.length).toBeGreaterThan(0);
    expect(orphans.every((r) => r.userId === null)).toBe(true);
  });

  it("returns the audio s3 keys still attached to the user's sessions", async () => {
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

    await db.insert(schema.audioFiles).values({
      sessionId: session.id,
      s3Key: "sessions/u1/abc.webm",
      fileSizeBytes: 1024,
      durationSeconds: 30,
      scheduledDeletionAt: new Date(Date.now() + 60_000),
    });

    await expireDeletion(user.id);
    const result = await hardDeleteUserRecord({ userId: user.id });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.s3KeysAttempted).toContain("sessions/u1/abc.webm");
  });

  it("returns the data_exports s3 keys for cleanup", async () => {
    const user = await insertUser();
    await db.insert(schema.dataExports).values({
      userId: user.id,
      status: "ready",
      s3Key: "exports/u1/zip-1.zip",
      fileSizeBytes: 12345,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      completedAt: new Date(),
    });

    await expireDeletion(user.id);
    const result = await hardDeleteUserRecord({ userId: user.id });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.s3KeysAttempted).toContain("exports/u1/zip-1.zip");
  });

  describe("TOCTTOU race against restoreAccount", () => {
    it("aborts (reason=restored) when deletion_requested_at was cleared between scan and tx", async () => {
      const user = await insertUser();
      // Cron's scan saw an expired deletion...
      await expireDeletion(user.id);
      // ...but the user restored their account before the tx ran.
      await db
        .update(schema.users)
        .set({ deletedAt: null, deletionRequestedAt: null })
        .where(eq(schema.users.id, user.id));

      const result = await hardDeleteUserRecord({ userId: user.id });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok=false");
      expect(result.reason).toBe("restored");

      // CRITICAL: the user row must still exist.
      const [stillThere] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, user.id));
      expect(stillThere?.id).toBe(user.id);
      expect(stillThere?.deletedAt).toBeNull();
    });

    it("aborts (reason=not_pending) when the deletion clock was reset (still inside grace window)", async () => {
      const user = await insertUser();
      await expireDeletion(user.id);
      // User re-initiated deletion (or some other state-machine
      // anomaly): deletion_requested_at is now fresh.
      const fresh = new Date(Date.now() - 60_000);
      await db
        .update(schema.users)
        .set({ deletedAt: fresh, deletionRequestedAt: fresh })
        .where(eq(schema.users.id, user.id));

      const result = await hardDeleteUserRecord({ userId: user.id });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok=false");
      expect(result.reason).toBe("not_pending");

      const [stillThere] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, user.id));
      expect(stillThere?.id).toBe(user.id);
    });

    it("aborts (reason=user_missing) when the user vanished between scan and tx", async () => {
      const result = await hardDeleteUserRecord({
        userId: "00000000-0000-0000-0000-000000000000",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok=false");
      expect(result.reason).toBe("user_missing");
    });

    it("REFUSES to delete a user with NO pending deletion (defensive guard)", async () => {
      const user = await insertUser();
      // No expireDeletion call — user is still active.

      const result = await hardDeleteUserRecord({ userId: user.id });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok=false");
      expect(result.reason).toBe("restored"); // deletion_requested_at IS NULL

      const [stillThere] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, user.id));
      expect(stillThere?.id).toBe(user.id);
    });
  });
});

describe("collectUserHardDeleteKeys", () => {
  it("returns audio + export keys for a user, separated by category", async () => {
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
    await db.insert(schema.audioFiles).values({
      sessionId: session.id,
      s3Key: "sessions/u/aaa.webm",
      fileSizeBytes: 1024,
      durationSeconds: 30,
      scheduledDeletionAt: new Date(Date.now() + 60_000),
    });
    await db.insert(schema.dataExports).values({
      userId: user.id,
      status: "ready",
      s3Key: "exports/u/zip.zip",
      fileSizeBytes: 100,
      expiresAt: new Date(Date.now() + 86_400_000),
      completedAt: new Date(),
    });

    const keys = await collectUserHardDeleteKeys(user.id);
    expect(keys.audioKeys).toEqual(["sessions/u/aaa.webm"]);
    expect(keys.exportKeys).toEqual(["exports/u/zip.zip"]);
  });

  it("excludes audio_files rows already marked deleted", async () => {
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
    await db.insert(schema.audioFiles).values({
      sessionId: session.id,
      s3Key: "sessions/u/already-deleted.webm",
      fileSizeBytes: 1024,
      durationSeconds: 30,
      scheduledDeletionAt: new Date(Date.now() - 60_000),
      deletedAt: new Date(Date.now() - 30_000),
    });

    const keys = await collectUserHardDeleteKeys(user.id);
    expect(keys.audioKeys).toEqual([]);
  });
});
