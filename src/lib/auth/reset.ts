import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { features, isProduction } from "@/lib/env";
import { sendPasswordResetEmailMessage } from "@/lib/email/templates";

/**
 * Password-reset flow.
 *
 * Mirrors `sendVerificationEmail` in shape so the dev / Resend
 * branches look identical and a future Resend-integration phase
 * wires both helpers with the same SDK call. The actual mail body
 * differs (reset link vs. verify link); the storage shape (random
 * UUID, 1h TTL, rotate-on-resend) is the same.
 *
 * Reset tokens go in their own `password_reset_tokens` table — NOT
 * `verification_tokens` — so a leaked verification token can never
 * be promoted into a reset grant. Different authorization scopes
 * deserve different stores.
 *
 * Doubles as the path Google-OAuth signups use to set a first
 * password: `users.password_hash` is nullable, the completion
 * handler writes to it whether it was previously NULL or held a
 * prior hash. The "this account uses Google sign-in" branch never
 * blocks the reset — it's how we let OAuth users join the
 * credentials world.
 */

/**
 * One hour, matching the verification token. Short enough that a
 * stale token leaked from logs / email forwarding becomes useless
 * before an attacker can use it. Long enough that a real user
 * landing on the email after lunch still has a working link.
 */
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

const baseUrl = (): string => {
  const fromEnv = process.env.NEXTAUTH_URL?.replace(/\/+$/, "");
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (isProduction) {
    throw new Error(
      "NEXTAUTH_URL must be set in production for password-reset emails to work",
    );
  }
  return "http://localhost:3000";
};

export interface SendPasswordResetEmailResult {
  /** True when the token row was written (always, unless the DB threw). */
  tokenIssued: boolean;
  /** True when an actual email was dispatched. False in dev / tests / no Resend. */
  emailDispatched: boolean;
  /** The reset URL — exposed for tests so they don't have to query the DB. */
  resetUrl: string;
}

/**
 * Mint a single-use reset token for `email`, rotating any prior
 * unconsumed token for the same identifier. Returns the reset URL
 * (consumed by `/reset-password` and dispatched via email).
 *
 * Caller MUST treat this as "always succeeds for valid input" from
 * the user's POV — the request-reset action returns a generic
 * "if the account exists, you'll get a link" message regardless of
 * whether we actually minted a token. Email-existence enumeration
 * via the reset endpoint is the bug we avoid.
 */
export async function sendPasswordResetEmail(
  email: string,
): Promise<SendPasswordResetEmailResult> {
  const token = randomUUID();
  const expires = new Date(Date.now() + TOKEN_LIFETIME_MS);

  // Rotate: drop any prior unconsumed token for this identifier so
  // the table doesn't accumulate stale rows when a user clicks
  // "forgot password" repeatedly. The composite PK on
  // (identifier, token) means a new row with a different token
  // would otherwise sit alongside the old one forever.
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.identifier, email));

    await tx.insert(schema.passwordResetTokens).values({
      identifier: email,
      token,
      expires,
    });
  });

  const resetUrl =
    `${baseUrl()}/reset-password` +
    `?token=${encodeURIComponent(token)}` +
    `&email=${encodeURIComponent(email)}`;

  if (!features.email) {
    if (!isProduction && process.env.NODE_ENV !== "test") {
      console.warn(
        `[auth] Password-reset email NOT sent (RESEND_API_KEY unset). ` +
          `Reset URL for ${email}: ${resetUrl}`,
      );
    } else if (isProduction) {
      console.error(
        `[auth] Password-reset email NOT sent for ${email}: RESEND_API_KEY is missing in production. ` +
          `Set RESEND_API_KEY + EMAIL_FROM_ADDRESS to dispatch.`,
      );
    }
    return { tokenIssued: true, emailDispatched: false, resetUrl };
  }

  // resetUrl must NOT be logged — it's a click-to-authenticate credential.
  const result = await sendPasswordResetEmailMessage({ to: email, resetUrl });
  if (!result.dispatched) {
    console.error(
      `[auth] Password-reset email failed to dispatch for ${email} (Resend error — see above).`,
    );
  } else {
    console.info(`[auth] Password-reset email dispatched for ${email} (id: ${result.id})`);
  }

  return { tokenIssued: true, emailDispatched: result.dispatched, resetUrl };
}

export interface ConsumePasswordResetTokenResult {
  ok: boolean;
  reason?:
    | "missing_params"
    | "invalid_token"
    | "expired"
    | "user_not_found";
}

/**
 * Validate a reset token and consume it. On success, deletes the
 * token row in the same transaction as the password update — so a
 * second click after a successful reset is a clean no-op (the
 * token row is already gone, the second call returns
 * `reason: "invalid_token"`).
 *
 * The caller is responsible for hashing the new password and
 * calling this helper with the hash; this module deliberately
 * doesn't take the plaintext password (keeps `@node-rs/argon2`
 * out of the import graph for any future module that wants to
 * just CHECK a token).
 */
export async function consumePasswordResetToken(args: {
  email: string;
  token: string;
  newPasswordHash: string;
}): Promise<ConsumePasswordResetTokenResult> {
  if (!args.email || !args.token || !args.newPasswordHash) {
    return { ok: false, reason: "missing_params" };
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        expires: schema.passwordResetTokens.expires,
      })
      .from(schema.passwordResetTokens)
      .where(
        and(
          eq(schema.passwordResetTokens.identifier, args.email),
          eq(schema.passwordResetTokens.token, args.token),
        ),
      )
      .limit(1);

    if (!row) return { ok: false, reason: "invalid_token" };

    if (row.expires.getTime() < Date.now()) {
      // Clean up the expired token so a later attempt doesn't keep
      // tripping over it.
      await tx
        .delete(schema.passwordResetTokens)
        .where(
          and(
            eq(schema.passwordResetTokens.identifier, args.email),
            eq(schema.passwordResetTokens.token, args.token),
          ),
        );
      return { ok: false, reason: "expired" };
    }

    // Update the password hash. We don't require an existing hash —
    // this is also the path Google-OAuth signups use to set their
    // first password. The `WHERE email = ...` filter is the only
    // gate; the caller is trusted to have verified the token shape
    // via the SELECT above.
    const updated = await tx
      .update(schema.users)
      .set({ passwordHash: args.newPasswordHash, updatedAt: new Date() })
      .where(eq(schema.users.email, args.email))
      .returning({ id: schema.users.id });

    if (updated.length === 0) {
      // The token was valid but the user no longer exists — likely
      // hard-deleted between request and completion. Leave the
      // token row alone (it'll expire) so the orphan state is
      // obvious in audit / debugging.
      return { ok: false, reason: "user_not_found" };
    }

    // Single-use: drop the token + any other outstanding tokens for
    // this identifier (defense in depth — a user with two
    // concurrent reset requests should never end up with a stale
    // token still usable after the first completion).
    await tx
      .delete(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.identifier, args.email));

    return { ok: true };
  });
}
