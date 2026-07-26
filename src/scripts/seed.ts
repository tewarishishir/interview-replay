/**
 * Local-dev seed: one test user with `SEED_CREDITS` credits and a
 * handful of example interview sessions across the round types and
 * life-cycle states the dashboard renders. Idempotent — re-running the
 * script reuses the existing user (matched by email) and replaces the
 * example sessions, so it's safe to call repeatedly during dev without
 * piling up rows.
 *
 * Run with:
 *   pnpm db:seed
 *
 * (which is `tsx --conditions=react-server --env-file=.env.local
 * src/scripts/seed.ts` — env must be loaded *before* `@/lib/env` is
 * imported, otherwise validation fails. The `react-server` condition
 * makes the `server-only` runtime guard imported via `auth/password`
 * resolve to a no-op `empty.js`, the same way Next.js does.)
 *
 * Refuses to run against a non-local DATABASE_URL as a guardrail;
 * bypass with ALLOW_REMOTE_SEED=1 if you really mean it.
 *
 * Constants and `sampleSessions` live in `./seed-fixtures.ts` so tests
 * can share the same source of truth without triggering this module's
 * side effects on import.
 */

import { eq } from "drizzle-orm";

import { hashPassword } from "@/lib/auth/password";

import { db, schema } from "../lib/db";

import {
  SEED_CREDITS,
  SEED_EMAIL,
  SEED_NAME,
  SEED_PASSWORD,
  sampleSessions,
} from "./seed-fixtures";

const isLocal = (url: string): boolean =>
  /@(localhost|127\.0\.0\.1)[:\/]/.test(url);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!isLocal(url) && process.env.ALLOW_REMOTE_SEED !== "1") {
    throw new Error(
      `Refusing to seed: DATABASE_URL does not look local (${url}).\n` +
        "Set ALLOW_REMOTE_SEED=1 to override.",
    );
  }

  const passwordHash = await hashPassword(SEED_PASSWORD);

  // Upsert by email so the script can run repeatedly. Reset credits to
  // a known value each time so dev-environment behavior stays
  // predictable (e.g. tests that rely on the starting balance).
  const [user] = await db
    .insert(schema.users)
    .values({
      email: SEED_EMAIL,
      name: SEED_NAME,
      passwordHash,
      creditBalance: SEED_CREDITS,
      freeCreditUsed: false,
      emailVerified: new Date(),
      isAdmin: true,
      termsAcceptedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.users.email,
      set: {
        passwordHash,
        creditBalance: SEED_CREDITS,
        updatedAt: new Date(),
        isAdmin: true,
        deletedAt: null,
        deletionRequestedAt: null,
        termsAcceptedAt: new Date(),
      },
    })
    .returning();

  if (!user) {
    throw new Error("Seed: failed to upsert user");
  }

  // Wipe prior example data for this user so re-running stays
  // idempotent. Cascades clear transcripts/artifacts/etc; the ledger
  // entries below are wiped explicitly because credit_transactions
  // doesn't cascade off the user (FK is RESTRICT) — we only delete
  // signup_bonus rows here so any real purchase history would survive.
  await db
    .delete(schema.interviewSessions)
    .where(eq(schema.interviewSessions.userId, user.id));
  await db
    .delete(schema.creditTransactions)
    .where(eq(schema.creditTransactions.userId, user.id));
  // Profile feature: also clear so re-running the seed (and the
  // e2e suite, which uses this seed user) starts from a clean
  // profile shell every time. The 1:1 row on user_profiles
  // cascade-deletes alongside; for the side tables we delete
  // explicitly because they're independent rows.
  await db
    .delete(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, user.id));
  await db
    .delete(schema.projects)
    .where(eq(schema.projects.userId, user.id));
  await db
    .delete(schema.stories)
    .where(eq(schema.stories.userId, user.id));
  await db
    .delete(schema.resumeParseJobs)
    .where(eq(schema.resumeParseJobs.userId, user.id));

  // Seed credit ledger so balance == sum(transactions) for the test
  // user. We mint the SEED_CREDITS as one signup_bonus row.
  await db.insert(schema.creditTransactions).values({
    userId: user.id,
    delta: SEED_CREDITS,
    balanceAfter: SEED_CREDITS,
    reason: "signup_bonus",
  });

  // Insert sessions back-dated by `daysAgo`. We use a raw `createdAt`
  // override so the dashboard list shows a realistic spread instead of
  // four rows all at "just now".
  const now = Date.now();
  for (const sample of sampleSessions) {
    const createdAt = new Date(now - sample.daysAgo * 86_400_000);
    await db.insert(schema.interviewSessions).values({
      userId: user.id,
      companyName: sample.companyName,
      roleTitle: sample.roleTitle,
      level: sample.level,
      roundType: sample.roundType,
      state: sample.state,
      consentAffirmedAt: createdAt,
      creditsCharged: sample.creditsCharged,
      createdAt,
      updatedAt: createdAt,
    });
  }

  // CLI script: stdout is the intended output channel here.
  /* eslint-disable no-console */
  console.log("Seed complete:");
  console.log("  user.id            =", user.id);
  console.log("  user.email         =", user.email);
  console.log("  user.password      =", SEED_PASSWORD, "(plaintext, dev only)");
  console.log("  user.creditBalance =", user.creditBalance);
  console.log("  sessions.count     =", sampleSessions.length);
  /* eslint-enable no-console */
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
