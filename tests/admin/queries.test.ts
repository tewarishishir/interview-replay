import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import {
  getDailyMetrics,
  getHealthAlerts,
  getWeeklyTrend,
} from "@/lib/admin/queries";

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

const NOW = new Date("2026-05-17T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

interface SeedUserArgs {
  email: string;
  createdAt: Date;
  signupCountryCode?: string | null;
}

async function seedUser(args: SeedUserArgs): Promise<string> {
  const [row] = await db
    .insert(schema.users)
    .values({
      email: args.email,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
      signupCountryCode: args.signupCountryCode ?? null,
    })
    .returning({ id: schema.users.id });
  return row!.id;
}

async function seedSession(args: {
  userId: string;
  state: "complete" | "failed" | "review" | "created";
  createdAt: Date;
  updatedAt?: Date;
}): Promise<string> {
  const [row] = await db
    .insert(schema.interviewSessions)
    .values({
      userId: args.userId,
      companyName: "Acme",
      roleTitle: "Engineer",
      level: "senior",
      roundType: "behavioral",
      state: args.state,
      consentAffirmedAt: args.createdAt,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt ?? args.createdAt,
    })
    .returning({ id: schema.interviewSessions.id });
  return row!.id;
}

async function seedAudit(userId: string, eventType: string, createdAt: Date): Promise<void> {
  await db.insert(schema.auditLog).values({
    userId,
    eventType,
    eventData: {},
    createdAt,
  });
}

describe("getDailyMetrics", () => {
  it("counts signups, active users, and completed sessions for the day", async () => {
    const today = NOW;
    const yesterday = new Date(NOW.getTime() - DAY);

    const a = await seedUser({ email: "a@example.com", createdAt: today });
    const b = await seedUser({ email: "b@example.com", createdAt: today });
    const c = await seedUser({ email: "c@example.com", createdAt: yesterday });

    await seedSession({
      userId: a,
      state: "complete",
      createdAt: new Date(today.getTime() - 3 * DAY),
      updatedAt: today,
    });

    await seedAudit(a, "signin_success", today);
    await seedAudit(b, "outcome_recorded", today);
    await seedAudit(c, "signin_success", yesterday);

    const metrics = await getDailyMetrics(today);
    expect(metrics.new_signups).toBe(2);
    expect(metrics.active_users).toBe(2);
    expect(metrics.sessions_analyzed).toBe(1);
  });

  it("excludes soft-deleted signups from new_signups", async () => {
    const today = NOW;
    await seedUser({ email: "live@example.com", createdAt: today });
    await seedUser({ email: "gone@example.com", createdAt: today });
    await db
      .update(schema.users)
      .set({ deletedAt: today })
      .where(eq(schema.users.email, "gone@example.com"));
    const metrics = await getDailyMetrics(today);
    expect(metrics.new_signups).toBe(1);
  });
});

describe("getWeeklyTrend", () => {
  it("returns 7 entries ending at the requested day, ascending", async () => {
    const u = await seedUser({
      email: "trend@example.com",
      createdAt: new Date(NOW.getTime() - 6 * DAY),
    });
    const u2 = await seedUser({
      email: "trend2@example.com",
      createdAt: new Date(NOW.getTime() - 2 * DAY),
    });
    await seedSession({
      userId: u,
      state: "complete",
      createdAt: new Date(NOW.getTime() - 5 * DAY),
      updatedAt: new Date(NOW.getTime() - 1 * DAY),
    });

    void u2;

    const trend = await getWeeklyTrend(NOW);
    expect(trend).toHaveLength(7);

    for (let i = 1; i < trend.length; i++) {
      expect(trend[i]!.date > trend[i - 1]!.date).toBe(true);
    }

    const total = trend.reduce(
      (acc, e) => ({
        signups: acc.signups + e.signups,
        sessions: acc.sessions + e.sessions,
      }),
      { signups: 0, sessions: 0 },
    );
    expect(total.signups).toBe(2);
    expect(total.sessions).toBe(1);
  });
});

describe("getHealthAlerts", () => {
  it("returns no alerts when nothing's tripped (no AI inferences, no failures)", async () => {
    const alerts = await getHealthAlerts(NOW);
    expect(alerts).toEqual([]);
  });

  it("trips a CRITICAL inference-confirmation alert at <50%", async () => {
    const u = await seedUser({
      email: "infer@example.com",
      createdAt: new Date(NOW.getTime() - 1 * DAY),
    });
    const session = await seedSession({
      userId: u,
      state: "review",
      createdAt: new Date(NOW.getTime() - 1 * DAY),
    });
    for (let i = 0; i < 12; i++) {
      await db.insert(schema.artifacts).values({
        sessionId: session,
        artifactType: "question",
        source: "ai_inferred",
        aiConfidence: "high",
        content: "did you ...?",
        userConfirmedAt: i < 4 ? new Date(NOW.getTime() - 1 * DAY) : null,
        createdAt: new Date(NOW.getTime() - 1 * DAY),
      });
    }
    const alerts = await getHealthAlerts(NOW);
    const inferAlert = alerts.find((a) => a.title.includes("Inference"));
    expect(inferAlert?.severity).toBe("critical");
  });

  it("trips a WARNING inference-confirmation alert in [50%, 70%)", async () => {
    const u = await seedUser({
      email: "infer2@example.com",
      createdAt: new Date(NOW.getTime() - 1 * DAY),
    });
    const session = await seedSession({
      userId: u,
      state: "review",
      createdAt: new Date(NOW.getTime() - 1 * DAY),
    });
    for (let i = 0; i < 10; i++) {
      await db.insert(schema.artifacts).values({
        sessionId: session,
        artifactType: "question",
        source: "ai_inferred",
        aiConfidence: "high",
        content: "q",
        userConfirmedAt: i < 6 ? new Date(NOW.getTime() - 1 * DAY) : null,
        createdAt: new Date(NOW.getTime() - 1 * DAY),
      });
    }
    const alerts = await getHealthAlerts(NOW);
    const inferAlert = alerts.find((a) => a.title.includes("Inference"));
    expect(inferAlert?.severity).toBe("warning");
  });

  it("trips a WARNING analysis-failure alert in (5%, 10%]", async () => {
    const u = await seedUser({
      email: "fail@example.com",
      createdAt: new Date(NOW.getTime() - 1 * DAY),
    });
    for (let i = 0; i < 18; i++) {
      await seedSession({
        userId: u,
        state: "complete",
        createdAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000),
        updatedAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000),
      });
    }
    for (let i = 0; i < 2; i++) {
      await seedSession({
        userId: u,
        state: "failed",
        createdAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000),
        updatedAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000),
      });
    }
    const alerts = await getHealthAlerts(NOW);
    const failAlert = alerts.find((a) => a.title.includes("Analysis failure"));
    expect(failAlert?.severity).toBe("warning");
  });

  it("trips an INFO non-Indian signups alert when any non-IN signup lands in the last 7 days", async () => {
    await seedUser({
      email: "foreign@example.com",
      createdAt: new Date(NOW.getTime() - 2 * DAY),
      signupCountryCode: "US",
    });
    const alerts = await getHealthAlerts(NOW);
    const geoAlert = alerts.find((a) => a.title.includes("non-Indian"));
    expect(geoAlert?.severity).toBe("info");
  });

  it("orders alerts critical → warning → info", async () => {
    const u = await seedUser({
      email: "sort1@example.com",
      createdAt: new Date(NOW.getTime() - 1 * DAY),
      signupCountryCode: "US",
    });
    const session = await seedSession({
      userId: u,
      state: "review",
      createdAt: new Date(NOW.getTime() - 1 * DAY),
    });
    for (let i = 0; i < 20; i++) {
      await db.insert(schema.artifacts).values({
        sessionId: session,
        artifactType: "question",
        source: "ai_inferred",
        aiConfidence: "high",
        content: "q",
        userConfirmedAt: null,
        createdAt: new Date(NOW.getTime() - 1 * DAY),
      });
    }
    const alerts = await getHealthAlerts(NOW);
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[alerts.length - 1]!.severity).toBe("info");
  });
});
