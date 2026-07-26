/**
 * Integration tests for `src/lib/admin/queries.ts`.
 *
 * Strategy:
 *   - Seed a small but representative dataset (signups, purchases,
 *     sessions, audit-log activity, artifacts) covering today,
 *     yesterday, and a few days earlier in the 7-day window.
 *   - Pin "now" to a deterministic timestamp so day boundaries are
 *     stable across runs.
 *   - Call each query function and assert the returned numbers
 *     exactly. Boundary conditions (threshold-trip alerts, empty
 *     funnels, NULL revenue days) get their own focused test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import {
  VARIABLE_COST_PER_SESSION_INR,
  getDailyMetrics,
  getFunnel,
  getHealthAlerts,
  getRevenueAndCost,
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

// Pinned "now" — UTC midday on a specific date so dayBounds-style
// math doesn't straddle a day boundary mid-test. Far enough in the
// past that no real "now > rowCreatedAt" check trips, but in 2026
// to match the seed era.
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
      // `consent_affirmed_at`-style cascade isn't relevant here;
      // defaults handle the rest of the row.
    })
    .returning({ id: schema.users.id });
  return row!.id;
}

async function seedPurchase(args: {
  userId: string;
  createdAt: Date;
  status: "pending" | "succeeded" | "failed" | "refunded";
  amountPaise: number;
  packType?: "starter" | "standard" | "heavy";
}): Promise<void> {
  await db.insert(schema.creditPurchases).values({
    userId: args.userId,
    packType: args.packType ?? "starter",
    creditsPurchased: 5,
    amountPaidPaise: args.amountPaise,
    gstAmountPaise: Math.floor((args.amountPaise * 18) / 118),
    txnId: `txn_${args.userId}_${args.createdAt.getTime()}_${Math.random()}`,
    status: args.status,
    createdAt: args.createdAt,
  });
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
  it("counts signups, paying users, revenue, active users, and completed sessions for the day", async () => {
    // Today (NOW): 2 signups, 1 purchase succeeded (₹500), 1 completed session
    // Yesterday: 1 signup, 1 purchase failed (no revenue), 1 active audit row
    const today = NOW;
    const yesterday = new Date(NOW.getTime() - DAY);

    const a = await seedUser({ email: "a@example.com", createdAt: today });
    const b = await seedUser({ email: "b@example.com", createdAt: today });
    const c = await seedUser({ email: "c@example.com", createdAt: yesterday });

    // First-paying-user-today: A made their first succeeded purchase today.
    await seedPurchase({
      userId: a,
      createdAt: today,
      status: "succeeded",
      amountPaise: 50_000,
    });
    // B has a pending purchase today — not paying yet.
    await seedPurchase({
      userId: b,
      createdAt: today,
      status: "pending",
      amountPaise: 30_000,
    });

    // Session completed today (created earlier but updated today).
    await seedSession({
      userId: a,
      state: "complete",
      createdAt: new Date(today.getTime() - 3 * DAY),
      updatedAt: today,
    });

    // Active-user audit rows today: a, b. Yesterday: c.
    await seedAudit(a, "signin_success", today);
    await seedAudit(b, "outcome_recorded", today);
    await seedAudit(c, "signin_success", yesterday);

    const metrics = await getDailyMetrics(today);
    expect(metrics).toEqual({
      new_signups: 2,
      new_paying_users: 1,
      revenue_inr: 500, // 50,000 paise → ₹500
      active_users: 2,
      sessions_analyzed: 1,
    });
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

  it("only counts the FIRST succeeded purchase as new_paying_users", async () => {
    const today = NOW;
    const yesterday = new Date(today.getTime() - DAY);
    const u = await seedUser({ email: "repeat@example.com", createdAt: yesterday });
    // First succeeded purchase: yesterday — should NOT count today
    await seedPurchase({
      userId: u,
      createdAt: yesterday,
      status: "succeeded",
      amountPaise: 50_000,
    });
    // Second succeeded purchase: today
    await seedPurchase({
      userId: u,
      createdAt: today,
      status: "succeeded",
      amountPaise: 50_000,
    });

    const todayMetrics = await getDailyMetrics(today);
    expect(todayMetrics.new_paying_users).toBe(0);
    // Today's revenue counts BOTH succeeded purchases on the day —
    // it's a per-day sum, not a per-user one.
    expect(todayMetrics.revenue_inr).toBe(500);

    const yMetrics = await getDailyMetrics(yesterday);
    expect(yMetrics.new_paying_users).toBe(1);
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
    // A succeeded purchase 2 days ago — first-paying for u2 then.
    await seedPurchase({
      userId: u2,
      createdAt: new Date(NOW.getTime() - 2 * DAY),
      status: "succeeded",
      amountPaise: 99_999,
    });
    // A completed session 1 day ago for u.
    await seedSession({
      userId: u,
      state: "complete",
      createdAt: new Date(NOW.getTime() - 5 * DAY),
      updatedAt: new Date(NOW.getTime() - 1 * DAY),
    });

    const trend = await getWeeklyTrend(NOW);
    expect(trend).toHaveLength(7);

    // Ascending date order
    for (let i = 1; i < trend.length; i++) {
      expect(trend[i]!.date > trend[i - 1]!.date).toBe(true);
    }

    const total = trend.reduce(
      (acc, e) => ({
        signups: acc.signups + e.signups,
        paying: acc.paying + e.paying_users,
        sessions: acc.sessions + e.sessions,
      }),
      { signups: 0, paying: 0, sessions: 0 },
    );
    expect(total.signups).toBe(2);
    expect(total.paying).toBe(1);
    expect(total.sessions).toBe(1);
  });
});

describe("getFunnel", () => {
  it("counts cohort → onboarded → first analysis → bought pack with the 30-day cap", async () => {
    const cohortStart = new Date(NOW.getTime() - 30 * DAY);
    const cohortEnd = NOW;

    // Cohort:
    //   u1: signup only (not onboarded)
    //   u2: signup + has a session (onboarded only)
    //   u3: signup + completed session within 30d
    //   u4: signup + completed session + succeeded purchase within 30d
    const u1 = await seedUser({
      email: "u1@example.com",
      createdAt: new Date(NOW.getTime() - 20 * DAY),
    });
    const u2 = await seedUser({
      email: "u2@example.com",
      createdAt: new Date(NOW.getTime() - 15 * DAY),
    });
    const u3 = await seedUser({
      email: "u3@example.com",
      createdAt: new Date(NOW.getTime() - 10 * DAY),
    });
    const u4 = await seedUser({
      email: "u4@example.com",
      createdAt: new Date(NOW.getTime() - 5 * DAY),
    });

    // u2: session in created state (not complete)
    await seedSession({
      userId: u2,
      state: "created",
      createdAt: new Date(NOW.getTime() - 14 * DAY),
    });
    // u3: completed session
    await seedSession({
      userId: u3,
      state: "complete",
      createdAt: new Date(NOW.getTime() - 8 * DAY),
    });
    // u4: completed session + purchase
    await seedSession({
      userId: u4,
      state: "complete",
      createdAt: new Date(NOW.getTime() - 3 * DAY),
    });
    await seedPurchase({
      userId: u4,
      createdAt: new Date(NOW.getTime() - 2 * DAY),
      status: "succeeded",
      amountPaise: 99_999,
    });

    void u1;

    const funnel = await getFunnel(cohortStart, cohortEnd);
    expect(funnel.signed_up).toBe(4);
    // u2, u3, u4 (have at least one session) → onboarded
    expect(funnel.onboarded).toBe(3);
    expect(funnel.first_analysis).toBe(2); // u3 + u4
    expect(funnel.bought_pack).toBe(1); // u4
  });

  it("ignores conversions that happen >30 days after signup", async () => {
    const cohortStart = new Date(NOW.getTime() - 60 * DAY);
    const cohortEnd = NOW;

    const old = await seedUser({
      email: "old@example.com",
      createdAt: new Date(NOW.getTime() - 50 * DAY),
    });
    // Purchase 40 days after signup → outside the 30-day window
    await seedPurchase({
      userId: old,
      createdAt: new Date(NOW.getTime() - 10 * DAY),
      status: "succeeded",
      amountPaise: 50_000,
    });

    const funnel = await getFunnel(cohortStart, cohortEnd);
    expect(funnel.signed_up).toBe(1);
    expect(funnel.bought_pack).toBe(0);
  });
});

describe("getRevenueAndCost", () => {
  it("computes revenue, variable cost, and gross margin over the window", async () => {
    const start = new Date(NOW.getTime() - 30 * DAY);
    const u = await seedUser({ email: "rev@example.com", createdAt: start });

    await seedPurchase({
      userId: u,
      createdAt: new Date(NOW.getTime() - 5 * DAY),
      status: "succeeded",
      amountPaise: 60_000, // ₹600
    });
    await seedPurchase({
      userId: u,
      createdAt: new Date(NOW.getTime() - 2 * DAY),
      status: "succeeded",
      amountPaise: 40_000, // ₹400
    });
    // Failed purchase in window — shouldn't count toward revenue
    await seedPurchase({
      userId: u,
      createdAt: new Date(NOW.getTime() - 1 * DAY),
      status: "failed",
      amountPaise: 99_999,
    });

    // 4 completed sessions in the window
    for (let i = 0; i < 4; i++) {
      await seedSession({
        userId: u,
        state: "complete",
        createdAt: new Date(NOW.getTime() - 4 * DAY),
        updatedAt: new Date(NOW.getTime() - (i + 1) * DAY),
      });
    }

    const result = await getRevenueAndCost(start, NOW);
    expect(result.revenue_inr).toBe(1000); // ₹600 + ₹400
    expect(result.packs_sold).toBe(2);
    expect(result.variable_cost_inr_estimate).toBe(4 * VARIABLE_COST_PER_SESSION_INR);
    expect(result.gross_margin_inr).toBe(1000 - 4 * VARIABLE_COST_PER_SESSION_INR);
    expect(result.gross_margin_pct).toBe(
      Math.round(((1000 - 4 * VARIABLE_COST_PER_SESSION_INR) / 1000) * 100),
    );
  });

  it("returns zeros (not NaN) when there are no purchases", async () => {
    const start = new Date(NOW.getTime() - 30 * DAY);
    const result = await getRevenueAndCost(start, NOW);
    expect(result.revenue_inr).toBe(0);
    expect(result.packs_sold).toBe(0);
    expect(result.variable_cost_inr_estimate).toBe(0);
    expect(result.gross_margin_inr).toBe(0);
    expect(result.gross_margin_pct).toBe(0);
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
    // 12 high-confidence AI-inferred artifacts, 4 confirmed → 33%
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
    // 10 high-confidence inferred, 6 confirmed → 60% → warning
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
    // 19 complete + 1 failed in the last 24h → 5% — should NOT trip
    // Boundary: spec says ">5%". Use 2/20 = 10% to land on warning.
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

  it("trips a WARNING payment-failures alert at >5 in 24h", async () => {
    const u = await seedUser({
      email: "card@example.com",
      createdAt: new Date(NOW.getTime() - 3 * DAY),
    });
    for (let i = 0; i < 6; i++) {
      await seedPurchase({
        userId: u,
        createdAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000),
        status: "failed",
        amountPaise: 50_000,
      });
    }
    const alerts = await getHealthAlerts(NOW);
    const payAlert = alerts.find((a) => a.title.includes("payment failures"));
    expect(payAlert?.severity).toBe("warning");
  });

  it("orders alerts critical → warning → info", async () => {
    // Set up one critical (inference < 50%) and one info (non-IN signup)
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
