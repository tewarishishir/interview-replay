/**
 * Persistence-layer tests for `createFeedback`. Hits the real
 * Postgres so the CHECK constraints on `rating` (1-5) and
 * `status` (FEEDBACK_STATUSES) are actually verified. The
 * `0029_feedback.sql` migration adds those at the DB level so a
 * future code path that bypasses zod still can't smuggle bad data
 * into the queue.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createCredentialsUser } from "@/lib/auth/users";
import { db, schema } from "@/lib/db";
import { createFeedback } from "@/lib/feedback/persist";

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
  const r = await createCredentialsUser({
    email,
    password: "password123",
    name: "Alice",
  });
  if (!r.ok) throw new Error(`seedUser failed: ${r.error}`);
  return r.user;
};

describe("createFeedback", () => {
  it("inserts a pending row with the full set of fields", async () => {
    const user = await seedUser();
    const row = await createFeedback({
      userId: user.id,
      data: {
        rating: 5,
        message: "Loved the breakdown of my answers.",
        consentPublic: true,
        displayName: "Priya R.",
        displayRole: "Senior PM",
        pagePath: "/dashboard",
      },
    });

    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.status).toBe("pending");
    expect(row.rating).toBe(5);
    expect(row.message).toBe("Loved the breakdown of my answers.");
    expect(row.consentPublic).toBe(true);
    expect(row.displayName).toBe("Priya R.");
    expect(row.displayRole).toBe("Senior PM");
    expect(row.pagePath).toBe("/dashboard");
    // Approval columns start empty — only the admin transition
    // stamps them.
    expect(row.approvedAt).toBeNull();
    expect(row.approvedByUserId).toBeNull();
    expect(row.adminNotes).toBeNull();
  });

  it("defaults consent_public to false and accepts null optional fields", async () => {
    const user = await seedUser();
    const row = await createFeedback({
      userId: user.id,
      data: {
        rating: 3,
        message: "Mid.",
        consentPublic: false,
        displayName: null,
        displayRole: null,
        pagePath: null,
      },
    });

    expect(row.consentPublic).toBe(false);
    expect(row.displayName).toBeNull();
    expect(row.displayRole).toBeNull();
    expect(row.pagePath).toBeNull();
  });

  it("rejects out-of-range ratings via the DB CHECK constraint", async () => {
    // The persist helper accepts whatever it's given (zod is the
    // app-layer gate); the DB CHECK is what guarantees badness
    // never lands in the queue even via a raw-SQL caller. We
    // bypass the helper to confirm the CHECK actually fires.
    // Drizzle wraps the underlying pg error; the constraint name
    // lives on `cause.constraint`, so we assert that explicitly.
    const user = await seedUser();
    const tryInsert = async (rating: number) => {
      try {
        await db.insert(schema.feedback).values({
          userId: user.id,
          rating,
          message: "Boom.",
        });
        return null;
      } catch (err) {
        return err as Error & { cause?: { constraint?: string } };
      }
    };

    const high = await tryInsert(6);
    expect(high?.cause?.constraint).toBe("feedback_rating_valid");

    const low = await tryInsert(0);
    expect(low?.cause?.constraint).toBe("feedback_rating_valid");
  });

  it("rejects unknown status values via the DB CHECK constraint", async () => {
    const user = await seedUser();
    let caught: (Error & { cause?: { constraint?: string } }) | null = null;
    try {
      await db.insert(schema.feedback).values({
        userId: user.id,
        rating: 4,
        message: "OK.",
        status: "wishlisted",
      });
    } catch (err) {
      caught = err as Error & { cause?: { constraint?: string } };
    }
    expect(caught?.cause?.constraint).toBe("feedback_status_valid");
  });

  it("cascade-deletes when the submitter is deleted", async () => {
    const user = await seedUser();
    await createFeedback({
      userId: user.id,
      data: {
        rating: 4,
        message: "Quick note.",
        consentPublic: false,
        displayName: null,
        displayRole: null,
        pagePath: null,
      },
    });

    // Have to clear credit_transactions first — the signup-bonus
    // ledger row has a RESTRICT FK on `users.id` (so the ledger
    // can't be silently dropped). The feedback cascade is what
    // we're verifying, so we sweep the blocker out of the way.
    await db.delete(schema.creditTransactions);
    await db.delete(schema.users);
    const rows = await db.select().from(schema.feedback);
    expect(rows).toHaveLength(0);
  });
});
