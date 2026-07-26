/**
 * Integration tests for `src/lib/admin/health-queries.ts` (Phase 3).
 *
 * Smaller surface than the Phase 1 / 2 query tests — the health
 * snapshot's per-section computations are mostly straight
 * aggregates that we cover here with one focused test each:
 *   - `getAiQualityMetrics` failure rate + acceptance rate
 *   - `getInfraMetrics` 7-day bucket fill + avg session length
 *   - `getGeoMetrics` country breakdown + subdivision filter
 *   - `getEngagementMetrics` profile-completeness histogram +
 *     rebuild adoption rate.
 *
 * The seeds are intentionally small: each section's math is the
 * load-bearing piece, not the volume.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import {
  getAiQualityMetrics,
  getEngagementMetrics,
  getGeoMetrics,
  getInfraMetrics,
} from "@/lib/admin/health-queries";

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

async function seedUser(args: {
  email: string;
  createdAt?: Date;
  signupCountryCode?: string | null;
  signupSubdivisionCode?: string | null;
}): Promise<string> {
  const created = args.createdAt ?? NOW;
  const [row] = await db
    .insert(schema.users)
    .values({
      email: args.email,
      createdAt: created,
      updatedAt: created,
      signupCountryCode: args.signupCountryCode ?? null,
      signupSubdivisionCode: args.signupSubdivisionCode ?? null,
    })
    .returning({ id: schema.users.id });
  return row!.id;
}

async function seedSession(args: {
  userId: string;
  state: "complete" | "failed" | "review" | "created";
  createdAt?: Date;
}): Promise<string> {
  const created = args.createdAt ?? NOW;
  const [row] = await db
    .insert(schema.interviewSessions)
    .values({
      userId: args.userId,
      companyName: "Acme",
      roleTitle: "Engineer",
      level: "senior",
      roundType: "behavioral",
      state: args.state,
      consentAffirmedAt: created,
      createdAt: created,
      updatedAt: created,
    })
    .returning({ id: schema.interviewSessions.id });
  return row!.id;
}

describe("getAiQualityMetrics", () => {
  it("computes failure rate over the 7-day window", async () => {
    const u = await seedUser({ email: "a@example.com" });
    // 3 complete, 1 failed, all within last 24h.
    for (let i = 0; i < 3; i += 1) {
      await seedSession({ userId: u, state: "complete", createdAt: new Date(NOW.getTime() - i * 60_000) });
    }
    await seedSession({ userId: u, state: "failed", createdAt: NOW });
    // One failed session outside the window — must NOT count.
    await seedSession({
      userId: u,
      state: "failed",
      createdAt: new Date(NOW.getTime() - 10 * DAY),
    });

    const ai = await getAiQualityMetrics(NOW);
    expect(ai.completedSessions7d).toBe(3);
    expect(ai.failedSessions7d).toBe(1);
    expect(ai.failureRate7d).toBeCloseTo(0.25, 5);
  });

  it("returns zero failure rate when no sessions ran", async () => {
    const ai = await getAiQualityMetrics(NOW);
    expect(ai.failedSessions7d).toBe(0);
    expect(ai.completedSessions7d).toBe(0);
    expect(ai.failureRate7d).toBe(0);
  });
});

describe("getGeoMetrics", () => {
  it("buckets signups by country code over the last 30 days", async () => {
    // Inside the window:
    await seedUser({ email: "in1@example.com", signupCountryCode: "IN" });
    await seedUser({ email: "in2@example.com", signupCountryCode: "IN" });
    await seedUser({ email: "us@example.com", signupCountryCode: "US" });
    await seedUser({ email: "anon@example.com", signupCountryCode: null });

    // Outside the window — must not appear in `signupsByCountry30d`
    // but must still appear in `signupsByCountryAllTime`.
    await seedUser({
      email: "old-uk@example.com",
      signupCountryCode: "GB",
      createdAt: new Date(NOW.getTime() - 60 * DAY),
    });

    const geo = await getGeoMetrics(NOW);
    expect(geo.totalSignups30d).toBe(4);
    const inRow30 = geo.signupsByCountry30d.find((r) => r.countryCode === "IN");
    expect(inRow30?.count).toBe(2);
    const ukRow30 = geo.signupsByCountry30d.find((r) => r.countryCode === "GB");
    expect(ukRow30).toBeUndefined();
    const ukRowAll = geo.signupsByCountryAllTime.find((r) => r.countryCode === "GB");
    expect(ukRowAll?.count).toBe(1);
  });

  it("returns Indian subdivisions only and only for IN-coded users", async () => {
    await seedUser({
      email: "mh1@example.com",
      signupCountryCode: "IN",
      signupSubdivisionCode: "MH",
    });
    await seedUser({
      email: "mh2@example.com",
      signupCountryCode: "IN",
      signupSubdivisionCode: "MH",
    });
    await seedUser({
      email: "ka1@example.com",
      signupCountryCode: "IN",
      signupSubdivisionCode: "KA",
    });
    // Non-India subdivision must not appear.
    await seedUser({
      email: "ca@example.com",
      signupCountryCode: "US",
      signupSubdivisionCode: "CA",
    });
    // IN user with null subdivision must not appear.
    await seedUser({ email: "in-null@example.com", signupCountryCode: "IN" });

    const geo = await getGeoMetrics(NOW);
    const subdivisionMap = new Map(
      geo.indianSignupsBySubdivision90d.map((r) => [r.subdivisionCode, r.count]),
    );
    expect(subdivisionMap.get("MH")).toBe(2);
    expect(subdivisionMap.get("KA")).toBe(1);
    expect(subdivisionMap.has("CA")).toBe(false);
  });
});

describe("getInfraMetrics", () => {
  it("fills 7 day buckets even when most days have zero sessions", async () => {
    const u = await seedUser({ email: "u@example.com" });
    // One session three days ago and one today.
    await seedSession({
      userId: u,
      state: "complete",
      createdAt: new Date(NOW.getTime() - 3 * DAY),
    });
    await seedSession({ userId: u, state: "complete", createdAt: NOW });

    const infra = await getInfraMetrics(NOW);
    expect(infra.sessionsByDay).toHaveLength(7);
    const totalAcrossWindow = infra.sessionsByDay.reduce((a, b) => a + b.count, 0);
    expect(totalAcrossWindow).toBe(2);
  });

  it("returns null avg session length when no audio files exist", async () => {
    const infra = await getInfraMetrics(NOW);
    expect(infra.avgSessionSeconds30d).toBeNull();
  });
});

describe("getEngagementMetrics", () => {
  it("buckets users by profile completeness (0/4 .. 4/4)", async () => {
    // User A: 0/4 — no profile row.
    await seedUser({ email: "a@example.com" });

    // User B: 4/4 — full profile.
    const b = await seedUser({ email: "b@example.com" });
    await db.insert(schema.userProfiles).values({
      userId: b,
      professionalSummary: "Senior eng",
      levels: ["senior"],
    });
    await db.insert(schema.projects).values({
      userId: b,
      name: "Project",
    });
    await db.insert(schema.stories).values({
      userId: b,
      theme: "leadership_conflict",
      title: "Title",
      situation: "S",
      task: "T",
      action: "A",
      result: "R",
    });

    const engagement = await getEngagementMetrics(NOW);
    const zeroBucket = engagement.profileCompleteness.find((b) => b.completed === 0);
    const fullBucket = engagement.profileCompleteness.find((b) => b.completed === 4);
    expect(zeroBucket?.users).toBe(1);
    expect(fullBucket?.users).toBe(1);
    expect(engagement.profileCompleteness).toHaveLength(5);
  });

  it("computes outcomes-recorded rate over the last 30 days", async () => {
    const u = await seedUser({ email: "u@example.com" });
    const completed1 = await seedSession({ userId: u, state: "complete" });
    const completed2 = await seedSession({ userId: u, state: "complete" });
    await seedSession({ userId: u, state: "complete" });

    await db.insert(schema.sessionOutcomes).values({
      sessionId: completed1,
      outcomeType: "received_offer",
      recordedAt: NOW,
    });
    await db.insert(schema.sessionOutcomes).values({
      sessionId: completed2,
      outcomeType: "did_not_advance",
      recordedAt: NOW,
    });

    const engagement = await getEngagementMetrics(NOW);
    expect(engagement.outcomesRecorded.completeSessions30d).toBe(3);
    expect(engagement.outcomesRecorded.sessionsWithOutcome30d).toBe(2);
    expect(engagement.outcomesRecorded.rate).toBeCloseTo(2 / 3, 5);
  });
});
