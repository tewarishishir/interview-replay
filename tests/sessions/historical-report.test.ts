/**
 * Integration tests for the read-side queries the
 * `/sessions/:id/reports/:reportId` page performs to render an
 * earlier (paid-for) analysis.
 *
 * The page runs three checks before rendering:
 *   1. Ownership — load the session by (id, userId). Anything
 *      missing or not-owned → 404.
 *   2. Identity  — load the report by (id, session_id). The
 *      session_id pin is the cross-tampering guard: a reportId
 *      stolen from a different session must NEVER resolve.
 *   3. Currency  — if the requested report is the latest, redirect
 *      to the canonical session detail page so the rebuild
 *      launchers etc. anchor on the canonical surface.
 *
 * These tests exercise the underlying queries directly against the
 * real local Postgres. The Next.js server-component shell is thin
 * (auth + redirect) — the load-bearing logic is the queries
 * themselves, which is what we cover here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";

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

const seedUser = async (email: string) => {
  const result = await createCredentialsUser({
    email,
    password: "password123",
    name: "Test",
  });
  if (!result.ok) throw new Error(`seedUser failed: ${result.error}`);
  return result.user;
};

const seedCompletedSession = async (userId: string) => {
  const row = await createSession({
    userId,
    companyName: "Stripe",
    roleTitle: "Backend Engineer",
    level: "senior",
    roundType: "coding",
    scheduledAt: null,
  });
  await db
    .update(schema.interviewSessions)
    .set({ state: "complete" })
    .where(eq(schema.interviewSessions.id, row.id));
  return row;
};

const setSessionState = async (
  sessionId: string,
  state: "complete" | "analyzing" | "failed",
) => {
  await db
    .update(schema.interviewSessions)
    .set({ state })
    .where(eq(schema.interviewSessions.id, sessionId));
};

const insertReport = async (sessionId: string, body: unknown, version: string) => {
  const [row] = await db
    .insert(schema.reports)
    .values({
      sessionId,
      reportJson: body,
      modelVersion: version,
      rubricVersion: version,
    })
    .returning();
  if (!row) throw new Error("insertReport: no row returned");
  return row;
};

// Mirror of the page's two-query load. Returns the state the page
// uses to decide between rendering, redirecting, or 404-ing.
const loadHistoricalView = async (
  sessionId: string,
  reportId: string,
  userId: string,
) => {
  const [sessionRow] = await db
    .select({
      id: schema.interviewSessions.id,
      state: schema.interviewSessions.state,
      deletedAt: schema.interviewSessions.deletedAt,
    })
    .from(schema.interviewSessions)
    .where(
      and(
        eq(schema.interviewSessions.id, sessionId),
        eq(schema.interviewSessions.userId, userId),
      ),
    )
    .limit(1);

  if (!sessionRow || sessionRow.deletedAt) {
    return { kind: "not_found" as const };
  }

  const [requested, latest] = await Promise.all([
    db
      .select({ id: schema.reports.id })
      .from(schema.reports)
      .where(
        and(
          eq(schema.reports.id, reportId),
          eq(schema.reports.sessionId, sessionId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: schema.reports.id })
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, sessionId))
      .orderBy(desc(schema.reports.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  if (!requested) return { kind: "not_found" as const };
  // Only redirect to the canonical page when the session is `complete`
  // — in `analyzing` or `failed` the canonical page wouldn't render
  // the report anyway and the user would lose access to the artifact
  // they paid for.
  if (
    sessionRow.state === "complete" &&
    latest &&
    latest.id === requested.id
  ) {
    return { kind: "redirect" as const };
  }
  return { kind: "render" as const, reportId: requested.id };
};

describe("historical report — happy path", () => {
  it("renders the requested earlier report when it exists and is not the latest", async () => {
    const user = await seedUser("alice@example.com");
    const session = await seedCompletedSession(user.id);

    const first = await insertReport(session.id, { v: 1 }, "v1");
    // Tiny gap so created_at is strictly increasing — the page
    // ordering relies on it.
    await new Promise((r) => setTimeout(r, 10));
    await insertReport(session.id, { v: 2 }, "v2");

    const result = await loadHistoricalView(session.id, first.id, user.id);
    expect(result).toEqual({ kind: "render", reportId: first.id });
  });
});

describe("historical report — currency redirect", () => {
  it("redirects to the canonical page when the URL points at the current report", async () => {
    const user = await seedUser("alice@example.com");
    const session = await seedCompletedSession(user.id);

    await insertReport(session.id, { v: 1 }, "v1");
    await new Promise((r) => setTimeout(r, 10));
    const second = await insertReport(session.id, { v: 2 }, "v2");

    const result = await loadHistoricalView(session.id, second.id, user.id);
    expect(result).toEqual({ kind: "redirect" });
  });

  it("redirects when only one report exists (the only row IS the current)", async () => {
    const user = await seedUser("alice@example.com");
    const session = await seedCompletedSession(user.id);

    const only = await insertReport(session.id, { v: 1 }, "v1");

    const result = await loadHistoricalView(session.id, only.id, user.id);
    expect(result).toEqual({ kind: "redirect" });
  });

  it("does NOT redirect when the session is `analyzing` (re-analysis in progress) — user still gets to read the prior report", async () => {
    // The user paid for the report. While a new analysis is running,
    // the canonical /sessions/:id renders the AnalyzingPanel which
    // hides the report — redirecting there from the historical URL
    // would deny the user access to an artifact they paid for.
    const user = await seedUser("alice@example.com");
    const session = await seedCompletedSession(user.id);

    const only = await insertReport(session.id, { v: 1 }, "v1");
    await setSessionState(session.id, "analyzing");

    const result = await loadHistoricalView(session.id, only.id, user.id);
    expect(result).toEqual({ kind: "render", reportId: only.id });
  });

  it("does NOT redirect when the session is `failed` — user still gets to read their last successful report", async () => {
    // After a re-analysis fails, the canonical page renders the
    // FailedPanel and not the report. The user paid for the report
    // and is entitled to read it via the historical URL even in
    // the failed state.
    const user = await seedUser("alice@example.com");
    const session = await seedCompletedSession(user.id);

    const only = await insertReport(session.id, { v: 1 }, "v1");
    await setSessionState(session.id, "failed");

    const result = await loadHistoricalView(session.id, only.id, user.id);
    expect(result).toEqual({ kind: "render", reportId: only.id });
  });
});

describe("historical report — ownership and tampering guards", () => {
  it("404s when the session is owned by a different user", async () => {
    const owner = await seedUser("owner@example.com");
    const intruder = await seedUser("intruder@example.com");
    const session = await seedCompletedSession(owner.id);

    const report = await insertReport(session.id, { v: 1 }, "v1");

    const result = await loadHistoricalView(session.id, report.id, intruder.id);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("404s when the reportId belongs to a different session (cross-session URL tampering)", async () => {
    // The page pins both `id` AND `session_id` on the report lookup
    // for exactly this case: a stolen reportId from session B must
    // NEVER resolve when the URL says session A.
    const user = await seedUser("alice@example.com");
    const sessionA = await seedCompletedSession(user.id);
    const sessionB = await seedCompletedSession(user.id);

    const reportInB = await insertReport(sessionB.id, { v: 1 }, "v1");

    const result = await loadHistoricalView(sessionA.id, reportInB.id, user.id);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("404s when the session is soft-deleted", async () => {
    const user = await seedUser("alice@example.com");
    const session = await seedCompletedSession(user.id);

    const report = await insertReport(session.id, { v: 1 }, "v1");

    await db
      .update(schema.interviewSessions)
      .set({ state: "deleted", deletedAt: new Date() })
      .where(eq(schema.interviewSessions.id, session.id));

    const result = await loadHistoricalView(session.id, report.id, user.id);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("404s when the report does not exist", async () => {
    const user = await seedUser("alice@example.com");
    const session = await seedCompletedSession(user.id);

    // No report inserted; URL points at a uuid that doesn't match.
    const result = await loadHistoricalView(
      session.id,
      "00000000-0000-0000-0000-000000000000",
      user.id,
    );
    expect(result).toEqual({ kind: "not_found" });
  });
});
