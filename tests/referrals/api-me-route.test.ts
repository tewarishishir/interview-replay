/**
 * Integration tests for GET /api/referrals/me — the endpoint that
 * powers the Account-page referral section + Dashboard nudge with
 * the user's code, share link, and live payout counts.
 *
 * Behaviors:
 *   - 401 for unauthenticated requests (no session).
 *   - 200 with { code, link, refereesCount, creditsEarned } for
 *     a signed-in user.
 *   - The code matches the user's `users.referral_code` column.
 *   - `refereesCount` reflects users with `referred_by_user_id =
 *     userId` (regardless of whether they've completed an analysis).
 *   - `creditsEarned` reflects the SUM of `referral_bonus` ledger
 *     deltas for this user.
 *   - The endpoint lazily backfills `users.referral_code` when
 *     the row predates the migration.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";

const DEFAULT_HEADERS = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
};
let headerOverride: Record<string, string> | null = null;
const setHeaders = (h: Record<string, string> | null) => {
  headerOverride = h;
};
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerOverride ?? DEFAULT_HEADERS),
}));

const mockGetActiveUserId = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getActiveUserId: () => mockGetActiveUserId(),
}));

import { GET } from "@/app/api/referrals/me/route";
import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  mockGetActiveUserId.mockReset();
  setHeaders(null);
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

const seedUser = async (email: string) => {
  const r = await createCredentialsUser({
    email,
    password: "password123",
    name: email,
  });
  if (!r.ok) throw new Error(`seedUser: ${r.error}`);
  return r.user;
};

describe("GET /api/referrals/me", () => {
  it("returns 401 when there is no signed-in user", async () => {
    mockGetActiveUserId.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("returns the user's code, link, and zero counts for a fresh account", async () => {
    const user = await seedUser("alice@example.com");
    mockGetActiveUserId.mockResolvedValueOnce(user.id);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    // The mocked headers say `host: localhost:3000`, so the link
    // should be the absolute https origin variant.
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(body.link).toMatch(
      new RegExp(`^https?://localhost:3000/signup\\?ref=${body.code}$`),
    );
    expect(body.refereesCount).toBe(0);
    expect(body.creditsEarned).toBe(0);

    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toBe("no-store");
  });

  it("counts a signed-up referee toward refereesCount even before any analysis", async () => {
    const referrer = await seedUser("ref@example.com");
    const [referrerRow] = await db
      .select({ referralCode: schema.users.referralCode })
      .from(schema.users)
      .where(eq(schema.users.id, referrer.id))
      .limit(1);
    expect(referrerRow?.referralCode).toBeTruthy();

    // Simulate an inbound signup attributed to this referrer.
    await createCredentialsUser({
      email: "alice@example.com",
      password: "password123",
      referralCode: referrerRow!.referralCode!,
    });

    mockGetActiveUserId.mockResolvedValueOnce(referrer.id);
    const res = await GET();
    const body = await res.json();
    expect(body.refereesCount).toBe(1);
    // No analysis yet, so no payout.
    expect(body.creditsEarned).toBe(0);
  });

  it("sums referral_bonus ledger rows into creditsEarned", async () => {
    const user = await seedUser("alice@example.com");

    // Synthesize two referral payouts directly on the ledger so
    // we don't have to drive the full analyze flow here (the
    // award path is already covered by award-on-first-analysis.test.ts).
    await db.insert(schema.creditTransactions).values([
      {
        userId: user.id,
        delta: 1,
        balanceAfter: 11,
        reason: "referral_bonus",
      },
      {
        userId: user.id,
        delta: 1,
        balanceAfter: 12,
        reason: "referral_bonus",
      },
    ]);

    mockGetActiveUserId.mockResolvedValueOnce(user.id);
    const res = await GET();
    const body = await res.json();
    expect(body.creditsEarned).toBe(2);
  });

  it("backfills the referral code if the row predates the migration", async () => {
    const user = await seedUser("alice@example.com");

    // Wipe the auto-minted code so we exercise the
    // ensureReferralCodeForUser backfill path.
    await db
      .update(schema.users)
      .set({ referralCode: null })
      .where(eq(schema.users.id, user.id));

    mockGetActiveUserId.mockResolvedValueOnce(user.id);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);

    const [row] = await db
      .select({ referralCode: schema.users.referralCode })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .limit(1);
    expect(row?.referralCode).toBe(body.code);
  });
});
