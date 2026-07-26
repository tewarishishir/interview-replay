import "server-only";

import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { User } from "@/lib/db/schema";

import { sendVerificationEmail } from "./email";
import { hashPassword, verifyPassword } from "./password";
import { sendWelcomeEmail } from "@/lib/email/templates";
import { geoFromHeaders, geoForIp } from "@/lib/geoip";

/**
 * Pure (request-context-free) user-management helpers. The server
 * actions in `./actions.ts` wrap these with rate limiting, redirects,
 * and FormData parsing; tests exercise them directly so we don't have
 * to mock `next/headers` or `signIn`.
 *
 * Each function is idempotent on its happy path and returns a small
 * discriminated result instead of throwing — callers branch on `.ok`.
 */

/**
 * Postgres `unique_violation` SQLSTATE. Wrapping it in a tiny
 * type-guard so the call site reads in plain English ("if this was a
 * duplicate, surface duplicate_email") and we don't sprinkle string
 * literals across the file.
 *
 * `pg`'s `DatabaseError` class isn't re-exported from `drizzle-orm`,
 * so we duck-type on the `code` property.
 */
const PG_UNIQUE_VIOLATION = "23505";
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

export interface CreateUserOk {
  ok: true;
  user: Pick<User, "id" | "email" | "name">;
  /** Verify URL surfaced for tests / dev console. */
  verifyUrl: string;
}

export interface CreateUserErr {
  ok: false;
  /** Stable, machine-readable error code. */
  error: "duplicate_email" | "insert_failed";
}

export type CreateUserResult = CreateUserOk | CreateUserErr;

/**
 * Create a credentials-flow user atomically:
 *   1. Verify no existing row with this email (friendly error vs. raw
 *      Postgres unique violation).
 *   2. Hash the password (argon2id, ~150–250 ms).
 *   3. INSERT the user row in a transaction.
 *   4. Issue a verification token (placeholder Resend dispatch). This
 *      is intentionally outside the transaction so a flaky email
 *      provider doesn't undo a successful signup.
 */
export async function createCredentialsUser(input: {
  email: string;
  password: string;
  name?: string | null;
  /**
   * Raw request headers from the signup action. When present, geo is
   * resolved via `geoFromHeaders` which checks common proxy geo
   * headers first, then falls back to MaxMind IP lookup. Preferred
   * over `signupIp` alone when available.
   */
  signupHeaders?: Headers | null;
  /**
   * Caller IP — used as a MaxMind fallback when `signupHeaders` is
   * absent or proxy geo headers are not set. Optional because tests
   * construct users directly and we don't want to gate user creation
   * on geography resolution.
   */
  signupIp?: string | null;
}): Promise<CreateUserResult> {
  const email = input.email.trim().toLowerCase();

  // The unique index on `email` is unconditional (covers soft-deleted
  // rows too), so a duplicate email here means we'd hit a Postgres
  // unique violation regardless of `deleted_at`. We can't safely
  // re-use a soft-deleted user's email — that would resurrect their
  // sessions. Surface as duplicate either way.
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (existing.length > 0) {
    return { ok: false, error: "duplicate_email" };
  }

  const passwordHash = await hashPassword(input.password);

  // Resolve signup country + subdivision (best-effort, no-op when
  // GeoIP isn't configured or the IP is reserved) BEFORE opening
  // the user-create transaction so the lookup latency doesn't sit
  // inside an open tx.
  //
  // Priority: proxy geo headers (x-geo-country / x-vercel-ip-country)
  // → MaxMind DB (when MAXMIND_GEOIP_DB_PATH is set) → null.
  // `geoFromHeaders` handles both cases.
  const { countryCode: signupCountryCode, subdivisionCode: signupSubdivisionCode } =
    input.signupHeaders
      ? await geoFromHeaders(input.signupHeaders, input.signupIp ?? undefined).catch(() => ({
          countryCode: null,
          subdivisionCode: null,
        }))
      : input.signupIp
        ? await geoForIp(input.signupIp).catch(() => ({
            countryCode: null,
            subdivisionCode: null,
          }))
        : { countryCode: null, subdivisionCode: null };

  // Race-window note: the `existing` check above and this insert are
  // not atomic. Two concurrent signups with the same email both pass
  // the precheck, then one trips the `users_email_key` unique index.
  // We translate that specific Postgres error (SQLSTATE 23505) back
  // into our `duplicate_email` discriminant so the loser sees the
  // same friendly UX as the sequential case.
  let dupViolation = false;
  const row = await db
    .transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.users)
        .values({
          email,
          name: input.name && input.name.trim().length > 0 ? input.name : null,
          passwordHash,
          signupCountryCode,
          signupSubdivisionCode,
        })
        .returning({
          id: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
        });

      if (!created) {
        throw new Error("createCredentialsUser: INSERT returned no row");
      }

      await tx.insert(schema.auditLog).values({
        eventType: "auth.signup",
        eventData: {
          email,
          user_id: created.id,
          signup_country_code: signupCountryCode,
        },
      });

      return created;
    })
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) {
        dupViolation = true;
        return null;
      }
      console.error("[createCredentialsUser] transaction failed:", err);
      return null;
    });

  if (dupViolation) {
    return { ok: false, error: "duplicate_email" };
  }
  if (!row) {
    return { ok: false, error: "insert_failed" };
  }

  // Best-effort verification email — failures don't block signup.
  let verifyUrl = "";
  try {
    const result = await sendVerificationEmail(email);
    verifyUrl = result.verifyUrl;
  } catch (err) {
    console.error("[createCredentialsUser] verification email failed:", err);
  }

  // Best-effort welcome email — sent after verification email so the
  // inbox ordering is: (1) verify your email, (2) welcome.
  try {
    await sendWelcomeEmail({ to: email, name: row.name });
  } catch (err) {
    console.warn("[createCredentialsUser] welcome email failed:", err);
  }

  return { ok: true, user: row, verifyUrl };
}

/**
 * Verify an email + password against the stored hash. Always runs
 * exactly one argon2 verify (even when the user doesn't exist) so the
 * caller can't infer account existence from response timing.
 *
 * Returns the user row on success, `null` on failure. The Auth.js
 * Credentials provider's `authorize` callback delegates to this so the
 * exact same check runs in tests as in production sign-in.
 *
 * Account-deletion grace window: a user inside their 30-day grace
 * window has `deleted_at IS NOT NULL` AND `deletion_requested_at`
 * within the last 30 days. We treat "successful sign-in inside
 * the grace window" as the auto-cancel signal — same source of
 * truth as the explicit `POST /api/me/restore` endpoint — and
 * resurrect the row before returning the user. This is the
 * "Sign back in to cancel" UX from the deletion-initiated email.
 */
export async function verifyCredentials(input: {
  email: string;
  password: string;
}): Promise<Pick<User, "id" | "email" | "name" | "image"> | null> {
  const { ACCOUNT_DELETION_GRACE_MS } = await import(
    "@/lib/compliance/constants"
  );

  const email = input.email.trim().toLowerCase();
  const now = new Date();
  const graceCutoff = new Date(now.getTime() - ACCOUNT_DELETION_GRACE_MS);

  // We accept rows where `deleted_at IS NULL` (active user) OR
  // `deletion_requested_at >= grace cutoff` (inside the grace
  // window — auto-restore on successful sign-in).
  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      image: schema.users.image,
      passwordHash: schema.users.passwordHash,
      deletedAt: schema.users.deletedAt,
      deletionRequestedAt: schema.users.deletionRequestedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  // Filter out hard-deleted-soon users at the auth boundary so the
  // timing-uniform verifyPassword call still runs.
  const isHardDeletePending = Boolean(
    user?.deletedAt &&
      (!user.deletionRequestedAt ||
        user.deletionRequestedAt.getTime() < graceCutoff.getTime()),
  );

  const ok = await verifyPassword(user?.passwordHash, input.password);
  if (!ok || !user || isHardDeletePending) return null;

  // Auto-restore if the user is inside the grace window. We don't
  // wait on this to return — but we DO await the UPDATE so the
  // session that follows gets a fresh row. Audit log is written
  // inside `restoreAccount` (imported lazily to avoid a circular
  // load between auth/users and compliance/deletion at module
  // init).
  if (
    user.deletedAt &&
    user.deletionRequestedAt &&
    user.deletionRequestedAt.getTime() >= graceCutoff.getTime()
  ) {
    const { restoreAccount } = await import("@/lib/compliance/deletion");
    try {
      await restoreAccount({ userId: user.id });
    } catch (err) {
      // If restore fails, refuse the sign-in — we don't want to
      // hand out a session that the (app) layout will then bounce
      // because `getDashboardUser` filters on deleted_at.
      console.error("[verifyCredentials] auto-restore failed:", err);
      return null;
    }
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
  };
}
