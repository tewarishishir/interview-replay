import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createSession } from "@/lib/sessions/create";
import { recordAnalysisFailure } from "@/lib/sessions/analyze";

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

describe("recordAnalysisFailure", () => {
  it("flips state to failed", async () => {
    const user = await seedUser();
    const session = await seedAnalyzingSession(user.id);

    await recordAnalysisFailure({
      sessionId: session.id,
      userId: user.id,
      errorMessage: "llm_timeout",
      creditsToRefund: 0,
    });

    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("failed");
  });

  it("is a no-op when the session is already in `failed` (idempotency)", async () => {
    const user = await seedUser();
    const session = await seedAnalyzingSession(user.id);

    await recordAnalysisFailure({
      sessionId: session.id,
      userId: user.id,
      errorMessage: "first_call",
      creditsToRefund: 0,
    });

    await recordAnalysisFailure({
      sessionId: session.id,
      userId: user.id,
      errorMessage: "second_call",
      creditsToRefund: 0,
    });

    const [s] = await db
      .select({ state: schema.interviewSessions.state })
      .from(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));
    expect(s?.state).toBe("failed");
  });
});
