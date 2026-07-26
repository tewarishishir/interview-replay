import "server-only";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { features, isProduction } from "@/lib/env";
import { sendVerificationEmailMessage } from "@/lib/email/templates";

/**
 * Email verification flow.
 *
 * Writes a row to `verification_tokens` and dispatches a verification
 * email via Resend. In dev/test (RESEND_API_KEY unset) it logs the
 * verify URL to stdout instead so contributors can click through locally.
 */

/**
 * Verification token lifetime.
 *
 * One hour is short enough that a stale token leaked from logs (an
 * old dev console line, an inadvertent error report) becomes useless
 * before an attacker can use it. Long enough that a real user
 * landing on the email after lunch still has a working link. If the
 * UX needs more headroom once `/verify-email` actually ships, raise
 * to 6 h — but don't go back to 24 h.
 */
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/**
 * Build the absolute base URL for verification links. We refuse to fall
 * back to localhost in production: a stale/missing `NEXTAUTH_URL`
 * shouldn't silently mint links nobody can click. In dev, localhost is
 * the right default.
 */
const baseUrl = (): string => {
  const fromEnv = process.env.NEXTAUTH_URL?.replace(/\/+$/, "");
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (isProduction) {
    // Throwing here is preferable to emailing customers a localhost link.
    throw new Error(
      "NEXTAUTH_URL must be set in production for verification emails to work",
    );
  }
  return "http://localhost:3000";
};

export interface SendVerificationEmailResult {
  /** True when the token row was written (always, unless the DB threw). */
  tokenIssued: boolean;
  /** True when an actual email was dispatched. False in dev / tests / no Resend. */
  emailDispatched: boolean;
  /** The verify URL — exposed for tests so they don't have to query the DB. */
  verifyUrl: string;
}

export async function sendVerificationEmail(
  email: string,
): Promise<SendVerificationEmailResult> {
  const token = randomUUID();
  const expires = new Date(Date.now() + TOKEN_LIFETIME_MS);

  // Replace any prior unconsumed token so we don't accumulate stale rows
  // when a user clicks "resend" multiple times. The composite PK on
  // (identifier, token) means multiple rows would pile up indefinitely
  // without this delete.
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.verificationTokens)
      .where(eq(schema.verificationTokens.identifier, email));

    await tx.insert(schema.verificationTokens).values({
      identifier: email,
      token,
      expires,
    });
  });

  // Our own verify endpoint (NOT Auth.js's `/api/auth/callback/email`,
  // which is meant for the passwordless-magic-link flow we don't use).
  // The route at `/api/auth/verify-email` validates the token against
  // `verification_tokens`, stamps `users.email_verified`, and redirects
  // back to signin with a `?verified=1` flash.
  const verifyUrl =
    `${baseUrl()}/api/auth/verify-email` +
    `?token=${encodeURIComponent(token)}` +
    `&email=${encodeURIComponent(email)}`;

  if (!features.email) {
    // Dev/test path: surface the URL so devs can click through during
    // local testing. We DELIBERATELY suppress this in production: even
    // if some operator somehow ran without RESEND_API_KEY in prod,
    // logging a click-to-verify URL into Datadog/CloudWatch is a real
    // account-takeover vector.
    if (!isProduction && process.env.NODE_ENV !== "test") {
      console.warn(
        `[auth] Verification email NOT sent (RESEND_API_KEY unset). ` +
          `Verify URL for ${email}: ${verifyUrl}`,
      );
    } else if (isProduction) {
      console.error(
        `[auth] Verification email NOT sent for ${email}: RESEND_API_KEY is missing in production. ` +
          `Set RESEND_API_KEY + EMAIL_FROM_ADDRESS to dispatch.`,
      );
    }
    return { tokenIssued: true, emailDispatched: false, verifyUrl };
  }

  // verifyUrl must NOT be logged — it's a click-to-authenticate credential.
  // Log only metadata so on-call can see "we tried to send" without leaking the token.
  const result = await sendVerificationEmailMessage({ to: email, verifyUrl });
  if (!result.dispatched) {
    console.error(
      `[auth] Verification email failed to dispatch for ${email} (Resend error — see above).`,
    );
  } else {
    console.info(`[auth] Verification email dispatched for ${email} (id: ${result.id})`);
  }

  return { tokenIssued: true, emailDispatched: result.dispatched, verifyUrl };
}
