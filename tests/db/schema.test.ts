/**
 * Smoke tests against a real local Postgres:
 *   1. Every table accepts a minimal valid insert.
 *   2. Foreign-key cascade rules behave as declared in the schema.
 *
 * These tests intentionally talk to the real DB instead of mocking
 * Drizzle, because the things they're verifying (cascade/restrict
 * semantics, CHECK constraints, default values) live in Postgres, not
 * in the ORM.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { count, eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { db, schema } from "@/lib/db";
import { SIGNUP_BONUS_CREDITS } from "@/lib/auth/constants";

import { ensureSchema, resetDatabase } from "./helpers";

const rowCount = async (table: PgTable): Promise<number> => {
  const rows = await db.select({ value: count() }).from(table);
  return rows[0]?.value ?? 0;
};

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  // node-postgres' Pool keeps the process alive; close it so vitest can exit.
  // Lazily required to avoid a hard import on `pg` from the test boundary.
  const { default: pgMod } = await import("pg");
  const pools = (pgMod as unknown as { native?: unknown }) && undefined;
  void pools;
  // The pool is owned by the global created in src/lib/db. Best-effort end:
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

const insertSession = async (userId: string) => {
  const [session] = await db
    .insert(schema.interviewSessions)
    .values({
      userId,
      companyName: "Acme",
      roleTitle: "Engineer",
      level: "senior",
      roundType: "coding",
      consentAffirmedAt: new Date(),
    })
    .returning();
  if (!session) throw new Error("insertSession: no row returned");
  return session;
};

describe("table inserts", () => {
  it("users — defaults credit_balance to the signup bonus, free_credit_used=false", async () => {
    const user = await insertUser();
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    // Column default lives in the schema; the application constant
    // mirrors it so the credit ledger's signup_bonus row matches.
    // We assert against the constant here so a future bump to the
    // bonus only needs to touch one place (constants.ts + the column
    // default) and this test follows.
    expect(user.creditBalance).toBe(SIGNUP_BONUS_CREDITS);
    expect(user.freeCreditUsed).toBe(false);
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.deletedAt).toBeNull();
  });

  it("users — email is unique", async () => {
    await insertUser("dup@example.com");
    await expect(insertUser("dup@example.com")).rejects.toThrow();
  });

  it("accounts — composite PK on (provider, providerAccountId)", async () => {
    const user = await insertUser();
    await db.insert(schema.accounts).values({
      userId: user.id,
      type: "oauth",
      provider: "github",
      providerAccountId: "12345",
    });

    await expect(
      db.insert(schema.accounts).values({
        userId: user.id,
        type: "oauth",
        provider: "github",
        providerAccountId: "12345",
      }),
    ).rejects.toThrow();
  });

  it("auth_sessions — accepts an Auth.js session row", async () => {
    const user = await insertUser();
    await db.insert(schema.authSessions).values({
      sessionToken: "sess-token-1",
      userId: user.id,
      expires: new Date(Date.now() + 86_400_000),
    });
    const rows = await db.select().from(schema.authSessions);
    expect(rows).toHaveLength(1);
  });

  it("verification_tokens — composite PK accepts insert", async () => {
    await db.insert(schema.verificationTokens).values({
      identifier: "alice@example.com",
      token: "tok-abc",
      expires: new Date(Date.now() + 3_600_000),
    });
    const rows = await db.select().from(schema.verificationTokens);
    expect(rows).toHaveLength(1);
  });

  it("interview_sessions — defaults state=created and retention_until ~30d out", async () => {
    const user = await insertUser();
    const session = await insertSession(user.id);

    expect(session.state).toBe("created");

    const now = Date.now();
    const retentionMs = session.retentionUntil.getTime() - now;
    const days = retentionMs / 86_400_000;
    expect(days).toBeGreaterThan(29.5);
    expect(days).toBeLessThan(30.5);
  });

  it("transcripts — accepts insert and enforces unique session_id", async () => {
    const user = await insertUser();
    const session = await insertSession(user.id);

    await db.insert(schema.transcripts).values({
      sessionId: session.id,
      rawText: "hello world",
      redactedText: "hello world",
      wordCount: 2,
      durationSeconds: 30,
      fillerWordCount: 0,
    });

    await expect(
      db.insert(schema.transcripts).values({
        sessionId: session.id,
        rawText: "again",
        redactedText: "again",
        wordCount: 1,
        durationSeconds: 5,
        fillerWordCount: 0,
      }),
    ).rejects.toThrow();
  });

  it("artifacts — defaults display_order=0", async () => {
    const user = await insertUser();
    const session = await insertSession(user.id);

    const [a] = await db
      .insert(schema.artifacts)
      .values({
        sessionId: session.id,
        artifactType: "code",
        content: "function foo() {}",
      })
      .returning();
    expect(a?.displayOrder).toBe(0);
  });

  it("reports — round-trips a JSONB body", async () => {
    const user = await insertUser();
    const session = await insertSession(user.id);

    const body = { score: 4.2, notes: ["tighten intro"] };
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: body,
      modelVersion: "ir-v1",
      rubricVersion: "rubric-v1",
    });

    const [row] = await db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, session.id));
    expect(row?.reportJson).toEqual(body);
  });

  it("reports — accepts multiple rows per session (re-analysis is append-only)", async () => {
    // Re-analysis no longer overwrites the prior report; each successful
    // analysis APPENDS a new row. The schema must allow this. If a
    // future migration accidentally re-introduces UNIQUE(session_id),
    // the second insert would throw and this test would catch it.
    const user = await insertUser();
    const session = await insertSession(user.id);

    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { v: 1 },
      modelVersion: "ir-v1",
      rubricVersion: "rubric-v1",
    });
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: { v: 2 },
      modelVersion: "ir-v1",
      rubricVersion: "rubric-v1",
    });

    const rows = await db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, session.id));
    expect(rows).toHaveLength(2);
  });

  it("audio_files — accepts a multi-GB file_size_bytes", async () => {
    const user = await insertUser();
    const session = await insertSession(user.id);

    const sixGb = 6 * 1024 * 1024 * 1024;
    await db.insert(schema.audioFiles).values({
      sessionId: session.id,
      s3Key: "s3://bucket/key.webm",
      fileSizeBytes: sixGb,
      durationSeconds: 3600,
      scheduledDeletionAt: new Date(Date.now() + 30 * 86_400_000),
    });

    const [row] = await db
      .select()
      .from(schema.audioFiles)
      .where(eq(schema.audioFiles.sessionId, session.id));
    expect(row?.fileSizeBytes).toBe(sixGb);
  });

  it("credit_purchases — enforces unique txn_id", async () => {
    const user = await insertUser();
    await db.insert(schema.creditPurchases).values({
      userId: user.id,
      packType: "starter",
      creditsPurchased: 10,
      amountPaidPaise: 999,
      txnId: "txn_dup",
      status: "succeeded",
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
    });

    await expect(
      db.insert(schema.creditPurchases).values({
        userId: user.id,
        packType: "starter",
        creditsPurchased: 10,
        amountPaidPaise: 999,
        txnId: "txn_dup",
        status: "succeeded",
        expiresAt: new Date(Date.now() + 365 * 86_400_000),
      }),
    ).rejects.toThrow();
  });

  it("credit_transactions — bigserial id auto-increments", async () => {
    const user = await insertUser();
    const [t1] = await db
      .insert(schema.creditTransactions)
      .values({
        userId: user.id,
        delta: 10,
        balanceAfter: 11,
        reason: "signup_bonus",
      })
      .returning();
    const [t2] = await db
      .insert(schema.creditTransactions)
      .values({
        userId: user.id,
        delta: -1,
        balanceAfter: 10,
        reason: "interview_charge",
      })
      .returning();
    expect(t1?.id).toBe(1);
    expect(t2?.id).toBe(2);
  });

  it("user_patterns — user_id is the PK", async () => {
    const user = await insertUser();
    await db.insert(schema.userPatterns).values({
      userId: user.id,
      patternsJson: { fillers: ["um", "like"] },
    });
    await expect(
      db.insert(schema.userPatterns).values({
        userId: user.id,
        patternsJson: {},
      }),
    ).rejects.toThrow();
  });

  it("audit_log — accepts insert with null user_id and an inet ip", async () => {
    await db.insert(schema.auditLog).values({
      userId: null,
      eventType: "auth.signin_failed",
      eventData: { reason: "bad_password" },
      ipAddress: "203.0.113.42",
      userAgent: "Mozilla/5.0 (test)",
    });
    expect(await rowCount(schema.auditLog)).toBe(1);
  });
});

describe("foreign-key behavior", () => {
  it("deleting a user cascades to interview_sessions", async () => {
    const user = await insertUser();
    await insertSession(user.id);

    await db.delete(schema.users).where(eq(schema.users.id, user.id));

    expect(await rowCount(schema.interviewSessions)).toBe(0);
  });

  it("deleting a user cascades to accounts and auth_sessions", async () => {
    const user = await insertUser();
    await db.insert(schema.accounts).values({
      userId: user.id,
      type: "oauth",
      provider: "google",
      providerAccountId: "g-1",
    });
    await db.insert(schema.authSessions).values({
      sessionToken: "tok-cascade",
      userId: user.id,
      expires: new Date(Date.now() + 86_400_000),
    });

    await db.delete(schema.users).where(eq(schema.users.id, user.id));

    expect(await rowCount(schema.accounts)).toBe(0);
    expect(await rowCount(schema.authSessions)).toBe(0);
  });

  it("deleting an interview_session cascades to transcript / artifact / report / audio_file", async () => {
    const user = await insertUser();
    const session = await insertSession(user.id);

    await db.insert(schema.transcripts).values({
      sessionId: session.id,
      rawText: "x",
      redactedText: "x",
      wordCount: 1,
      durationSeconds: 1,
      fillerWordCount: 0,
    });
    await db.insert(schema.artifacts).values({
      sessionId: session.id,
      artifactType: "notes",
      content: "n",
    });
    await db.insert(schema.reports).values({
      sessionId: session.id,
      reportJson: {},
      modelVersion: "v1",
      rubricVersion: "v1",
    });
    await db.insert(schema.audioFiles).values({
      sessionId: session.id,
      s3Key: "k",
      fileSizeBytes: 1,
      durationSeconds: 1,
      scheduledDeletionAt: new Date(Date.now() + 86_400_000),
    });

    await db
      .delete(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));

    expect(await rowCount(schema.transcripts)).toBe(0);
    expect(await rowCount(schema.artifacts)).toBe(0);
    expect(await rowCount(schema.reports)).toBe(0);
    expect(await rowCount(schema.audioFiles)).toBe(0);
  });

  it("deleting a user is RESTRICTed when credit_purchases exist", async () => {
    const user = await insertUser();
    await db.insert(schema.creditPurchases).values({
      userId: user.id,
      packType: "starter",
      creditsPurchased: 10,
      amountPaidPaise: 999,
      txnId: "txn_restrict",
      status: "succeeded",
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
    });

    await expect(
      db.delete(schema.users).where(eq(schema.users.id, user.id)),
    ).rejects.toThrow();
  });

  it("deleting an interview_session NULLs out credit_transactions.related_session_id (preserves ledger)", async () => {
    const user = await insertUser();
    const session = await insertSession(user.id);

    await db.insert(schema.creditTransactions).values({
      userId: user.id,
      delta: -1,
      balanceAfter: 0,
      reason: "interview_charge",
      relatedSessionId: session.id,
    });

    await db
      .delete(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));

    const [tx] = await db.select().from(schema.creditTransactions);
    expect(tx?.relatedSessionId).toBeNull();
    // Ledger row itself must survive — never deleted.
    expect(tx?.delta).toBe(-1);
  });

  it("deleting a user nulls out audit_log.user_id (preserves audit history)", async () => {
    const user = await insertUser();
    await db.insert(schema.auditLog).values({
      userId: user.id,
      eventType: "session.completed",
      eventData: { ok: true },
    });

    await db.delete(schema.users).where(eq(schema.users.id, user.id));

    const rows = await db.select().from(schema.auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBeNull();
  });

  it("partial index `interview_sessions_user_created_idx` is registered with WHERE deleted_at IS NULL", async () => {
    // Sanity check that the migration actually shipped the partial index
    // — this is a regression guard for the indexes block in interviews.ts.
    const { rows } = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'interview_sessions_user_created_idx'
    `);
    expect(rows[0]?.indexdef).toMatch(/WHERE.*deleted_at IS NULL/i);
  });

  it("composite index `reports_session_created_idx` is (session_id, created_at DESC)", async () => {
    // Powers the session detail page's report enumeration (ORDER BY
    // created_at DESC) for the full "Previous analyses" history, as
    // well as LIMIT 1 latest-only fetches elsewhere. Both rely on the
    // DESC direction being encoded in the index; if migration 0016
    // ever ships without it, this test catches the regression.
    const { rows } = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'reports_session_created_idx'
    `);
    expect(rows[0]?.indexdef).toBeDefined();
    expect(rows[0]?.indexdef).toMatch(/session_id/i);
    expect(rows[0]?.indexdef).toMatch(/created_at\s+DESC/i);
  });

  it("`reports_session_id_unique` constraint was dropped (multi-row append-only)", async () => {
    // Defense-in-depth complement to the multi-row insert test above:
    // we explicitly assert the unique constraint is GONE, so a future
    // schema-regen that quietly re-adds `.unique()` to `sessionId`
    // would fail here even before any insert path is exercised.
    const { rows } = await db.execute<{ conname: string }>(sql`
      SELECT conname FROM pg_constraint
      WHERE conname = 'reports_session_id_unique'
    `);
    expect(rows).toHaveLength(0);
  });

  it("`feedback_rating_valid` CHECK enforces rating ∈ [1,5]", async () => {
    // Defense in depth: the zod schema rejects out-of-range
    // ratings at the API edge, but a future code path that
    // bypasses zod (manual SQL, an job runner worker, a Server
    // Action that builds a raw INSERT) must still be blocked.
    const { rows } = await db.execute<{ pg_get_constraintdef: string }>(sql`
      SELECT pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conname = 'feedback_rating_valid'
    `);
    expect(rows[0]?.pg_get_constraintdef ?? "").toMatch(/rating >= 1/i);
    expect(rows[0]?.pg_get_constraintdef ?? "").toMatch(/rating <= 5/i);
  });

  it("`feedback_status_valid` CHECK locks status to the documented set", async () => {
    const { rows } = await db.execute<{ pg_get_constraintdef: string }>(sql`
      SELECT pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conname = 'feedback_status_valid'
    `);
    const def = rows[0]?.pg_get_constraintdef ?? "";
    expect(def).toMatch(/pending/);
    expect(def).toMatch(/approved/);
    expect(def).toMatch(/rejected/);
  });

  it("`feedback_approved_idx` is partial — approved + consent_public only", async () => {
    // Powers the future testimonials query. The partial WHERE
    // clause is the whole point — without it the index would
    // surface every approved row regardless of consent, and a
    // future code path could accidentally render a user's
    // feedback publicly. This test is the regression guard for
    // that shape.
    const { rows } = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'feedback_approved_idx'
    `);
    const def = rows[0]?.indexdef ?? "";
    expect(def).toMatch(/approved_at\s+DESC/i);
    expect(def).toMatch(/WHERE.*status\s*=\s*'approved'/i);
    expect(def).toMatch(/consent_public\s*=\s*true/i);
  });
});
