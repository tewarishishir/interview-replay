/**
 * Integration tests for `persistReportAndComplete` — the worker's
 * happy-path helper that inserts the analysis result and advances
 * the session into `complete`.
 *
 * Headline contract under test: re-analysis is APPEND-ONLY. Each
 * successful run inserts a new `reports` row; the previous row is
 * preserved for the lifetime of the session. The user paid for each
 * run and is entitled to view prior versions via
 * `/sessions/:id/reports/:reportId`.
 *
 * Also covers:
 *   - First analysis writes one row, session advances to `complete`,
 *     audit row is written.
 *   - The state-CAS guard rejects a session that's been moved out
 *     of `analyzing` (e.g. soft-deleted under us); the report row is
 *     rolled back when this happens.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";
import { persistReportAndComplete } from "@/lib/sessions/analyze";
import type { Report } from "@/lib/llm";

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

const seedUser = async (email = "alice@example.com") => {
  const result = await createCredentialsUser({
    email,
    password: "password123",
    name: "Alice",
  });
  if (!result.ok) throw new Error(`seedUser failed: ${result.error}`);
  return result.user;
};

const seedAnalyzingSession = async (userId: string) => {
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
    .set({ state: "analyzing" })
    .where(eq(schema.interviewSessions.id, row.id));
  return row;
};

const sampleReport = (label: string): Report => ({
  executiveSummary: `Summary v${label}.`,
  strengths: [
    {
      heading: `Strength v${label}`,
      detail: `Detail v${label}`,
      evidence: [],
    },
  ],
  improvements: [
    {
      heading: `Improvement v${label}`,
      detail: `Detail v${label}`,
      action: `Action v${label}`,
      evidence: [],
      rebuildEligible: false,
    },
  ],
  communicationSignals: {
    pace: { summary: "ok" },
    fillerWords: { summary: "ok", topOffenders: [] },
    structure: { summary: "ok" },
    presence: { summary: "ok" },
  },
  roundSpecific: {
    kind: "coding",
    problemFraming: "ok",
    solutionExploration: "ok",
    implementationHygiene: "ok",
    verification: "ok",
    recoveryFromFeedback: "ok",
  },
  aiRead: { paragraph: `InterviewReplay'ed read v${label}` },
  questionsCovered: [],
  storyHighlights: [],
});

describe("persistReportAndComplete — first analysis", () => {
  it("inserts one row, advances state to complete, writes audit row", async () => {
    const user = await seedUser();
    const session = await seedAnalyzingSession(user.id);

    const { reportId } = await persistReportAndComplete({
      sessionId: session.id,
      userId: user.id,
      report: sampleReport("1"),
      modelVersion: "ir-v1",
      rubricVersion: "rubric-v1",
    });

    const reports = await db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, session.id));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.id).toBe(reportId);

    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("complete");

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.eventType, "session.report.completed"));
    expect(audit).toHaveLength(1);
  });
});

describe("persistReportAndComplete — re-analysis is append-only", () => {
  it("a second run APPENDS a new row; the older row remains readable", async () => {
    // The user re-analyzed: prior report was the result of the first
    // run. We simulate that by writing the first row, flipping the
    // session back to `analyzing` (which is what the API route does
    // when a re-analysis is consumed), then calling `persistReport...`
    // a second time.
    const user = await seedUser();
    const session = await seedAnalyzingSession(user.id);

    const first = await persistReportAndComplete({
      sessionId: session.id,
      userId: user.id,
      report: sampleReport("1"),
      modelVersion: "ir-v1",
      rubricVersion: "rubric-v1",
    });

    // Move back to `analyzing` to mimic the start of a re-analysis.
    await db
      .update(schema.interviewSessions)
      .set({ state: "analyzing" })
      .where(eq(schema.interviewSessions.id, session.id));

    // Tiny gap so `created_at` is strictly increasing — the page
    // ordering relies on it. 10ms is well above Postgres' timestamp
    // resolution and small enough to keep the test fast.
    await new Promise((r) => setTimeout(r, 10));

    const second = await persistReportAndComplete({
      sessionId: session.id,
      userId: user.id,
      report: sampleReport("2"),
      modelVersion: "ir-v2",
      rubricVersion: "rubric-v2",
    });

    expect(second.reportId).not.toBe(first.reportId);

    const rows = await db
      .select({
        id: schema.reports.id,
        modelVersion: schema.reports.modelVersion,
        createdAt: schema.reports.createdAt,
      })
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, session.id))
      .orderBy(asc(schema.reports.createdAt));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(first.reportId);
    expect(rows[1]?.id).toBe(second.reportId);

    // The "latest" read the session detail page does must surface the
    // newer row.
    const [latest] = await db
      .select({
        id: schema.reports.id,
        modelVersion: schema.reports.modelVersion,
      })
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, session.id))
      .orderBy(desc(schema.reports.createdAt))
      .limit(1);
    expect(latest?.id).toBe(second.reportId);
    expect(latest?.modelVersion).toBe("ir-v2");

    // Two completion-audit rows, one per run.
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.eventType, "session.report.completed"));
    expect(audit).toHaveLength(2);
  });
});

describe("persistReportAndComplete — state guard", () => {
  it("rolls back the report row when the session has been moved out of `analyzing`", async () => {
    // A concurrent soft-delete (or a /reset that flipped to `failed`)
    // would race with the worker write. The transaction's CAS on
    // state must abort the whole insert so we never end up with a
    // report attached to a state-incoherent session.
    const user = await seedUser();
    const session = await seedAnalyzingSession(user.id);

    // Pre-emptively move the session out of `analyzing` to simulate
    // the race.
    await db
      .update(schema.interviewSessions)
      .set({ state: "deleted", deletedAt: new Date() })
      .where(eq(schema.interviewSessions.id, session.id));

    await expect(
      persistReportAndComplete({
        sessionId: session.id,
        userId: user.id,
        report: sampleReport("x"),
        modelVersion: "ir-v1",
        rubricVersion: "rubric-v1",
      }),
    ).rejects.toThrow(/state guard failed/);

    const reports = await db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, session.id));
    expect(reports).toHaveLength(0);

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.eventType, "session.report.completed"),
        ),
      );
    expect(audit).toHaveLength(0);
  });
});
