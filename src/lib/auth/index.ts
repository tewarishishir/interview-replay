import { headers } from "next/headers";
import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { env, features } from "@/lib/env";
import { geoFromHeaders } from "@/lib/geoip";
import { ipFromHeaders } from "@/lib/rate-limit";
import { authConfig } from "./config";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./constants";
import { sendVerificationEmail } from "./email";
import { verifyPassword } from "./password";
import { verifyCredentials } from "./users";

/**
 * Email is normalized (trim + lowercase) at the edge of the system so a
 * single user can't accidentally register `Alice@Example.com` and
 * `alice@example.com` as two accounts.
 *
 * Order matters: trim and lowercase BEFORE `.email()` so that mobile
 * keyboards' trailing-space autocomplete (e.g. " alice@example.com ")
 * normalizes cleanly instead of failing the email shape check.
 */
export const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(320) // RFC 5321 practical cap
    .pipe(z.string().email()),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH),
});

/**
 * NOTE on session strategy.
 *
 * The original spec asked for `session: { strategy: "database" }` "since
 * we're using Drizzle". Auth.js v5 does not support database sessions
 * with the Credentials provider — attempting it crashes with
 * `UnsupportedStrategy: Signing in with credentials only supported if
 * JWT strategy is enabled` (see authjs.dev/getting-started/authentication/credentials).
 *
 * We therefore stay on JWT for both Credentials *and* OAuth (mixing
 * strategies isn't supported either). Defense-in-depth for revocation is
 * the per-request DB existence check in `src/app/(app)/layout.tsx`, plus
 * the `events.signIn` hook below which catches OAuth flows the moment
 * the row is written.
 */
const fullConfig: NextAuthConfig = {
  ...authConfig,

  adapter: DrizzleAdapter(db, {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    // `interview_sessions` is our domain table; Auth.js needs its own
    // session table, exported from `schema/users.ts` as `authSessions`.
    sessionsTable: schema.authSessions,
    verificationTokensTable: schema.verificationTokens,
  }),

  providers: [
    // Google is conditional on env so a fresh dev clone without OAuth
    // credentials still boots and can use email/password sign-in.
    ...(features.googleAuth
      ? [
          Google({
            clientId: env.AUTH_GOOGLE_ID!,
            clientSecret: env.AUTH_GOOGLE_SECRET!,
            // Google's default profile callback doesn't pass through
            // `email_verified`. We re-implement it so the
            // `emailVerified` column is populated from the actual JWT
            // claim, not just stamped unconditionally on createUser.
            // For Workspace accounts whose admin disabled email
            // verification this will be false — and we'll honor that.
            profile: (profile) => ({
              id: profile.sub,
              name: profile.name,
              email: profile.email,
              image: profile.picture,
              emailVerified: profile.email_verified ? new Date() : null,
            }),
            allowDangerousEmailAccountLinking: false,
          }),
        ]
      : []),

    Credentials({
      name: "Email & password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (raw) => {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) {
          // Run a dummy verify to equalize response time with the
          // "bad password" path inside `verifyCredentials`.
          await verifyPassword(null, "");
          return null;
        }
        return verifyCredentials(parsed.data);
      },
    }),
  ],

  callbacks: {
    ...authConfig.callbacks,

    /**
     * Staging-only admin gate. When APP_ENV=staging, deny sign-in for
     * any user who doesn't have `is_admin = true` in the DB. This runs
     * after `authorize` (credentials) or after the OAuth profile is
     * resolved (Google), so `user.id` is the DB row's id.
     *
     * Returning a URL string instead of `false` lets us redirect to a
     * friendly error on the sign-in page rather than NextAuth's generic
     * "Access Denied" screen.
     */
    signIn: async ({ user }) => {
      if (env.APP_ENV !== "staging") return true;
      if (!user.id) return "/signin?error=staging_admin_only";

      try {
        const [row] = await db
          .select({ isAdmin: schema.users.isAdmin })
          .from(schema.users)
          .where(
            and(
              eq(schema.users.id, user.id),
              eq(schema.users.isAdmin, true),
              isNull(schema.users.deletedAt),
            ),
          )
          .limit(1);
        if (row) return true;
      } catch (err) {
        console.error("[auth.signIn] staging admin check failed:", err);
        return "/signin?error=staging_admin_only";
      }

      return "/signin?error=staging_admin_only";
    },
  },

  events: {
    /**
     * Fires only when the Drizzle adapter creates a new user — i.e. on
     * the first OAuth sign-in. Email/password signups create the user
     * row directly in `lib/auth/users.ts` and handle verification-email
     * there, so this hook is the OAuth-only path.
     *
     * Side-effects: stamp geo columns on the user row and dispatch a
     * verification email when the provider didn't verify the address.
     *
     * `emailVerified` is intentionally *not* stamped here. We rely on
     * the provider's `profile()` callback (see Google config above) to
     * populate it from the OAuth `email_verified` claim. Stamping it
     * blindly in this event would launder unverified OAuth flows
     * into "verified" — a real problem for any future provider that
     * doesn't verify email.
     */
    createUser: async ({ user }) => {
      if (!user.id) return;

      // Resolve signup country + subdivision from the OAuth-callback
      // request IP. Mirrors the credentials-signup path in
      // `lib/auth/users.ts`. Best-effort: any failure (no DB, reserved
      // IP, lookup throws) leaves both columns NULL and the rest of
      // the createUser flow continues normally.
      let oauthSignupCountryCode: string | null = null;
      let oauthSignupSubdivisionCode: string | null = null;
      try {
        const reqHeaders = await headers();
        const ip = ipFromHeaders(reqHeaders) ?? undefined;
        const geo = await geoFromHeaders(reqHeaders, ip).catch(() => ({
          countryCode: null,
          subdivisionCode: null,
        }));
        oauthSignupCountryCode = geo.countryCode;
        oauthSignupSubdivisionCode = geo.subdivisionCode;
      } catch (err) {
        console.error("[auth.createUser] geo lookup failed:", err);
      }

      const userId = user.id;

      if (oauthSignupCountryCode != null || oauthSignupSubdivisionCode != null) {
        await db
          .update(schema.users)
          .set({
            signupCountryCode: oauthSignupCountryCode,
            signupSubdivisionCode: oauthSignupSubdivisionCode,
          })
          .where(eq(schema.users.id, userId));
      }

      // Send verification email for OAuth users whose provider did not
      // supply a verified email. Google almost always sets email_verified,
      // but workspace/managed accounts or future providers may not. When
      // emailVerified is null the (app) layout will gate the user behind
      // /verify-email-required, so we must dispatch the email here — the
      // credentials path handles this inside createCredentialsUser, but
      // OAuth users are created by the adapter and only reach this event.
      //
      // Auth.js types the event `user` as `User` (no emailVerified field) even
      // though the adapter always populates it from the provider profile. Query
      // the freshly-written row instead — we have userId in scope and a single
      // index hit is negligible here.
      const [freshRow] = await db
        .select({ emailVerified: schema.users.emailVerified })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      if (freshRow?.emailVerified == null && user.email) {
        try {
          await sendVerificationEmail(user.email);
        } catch (err) {
          console.error("[auth.createUser] verification email failed:", err);
        }
      }
    },
  },
};

// Re-exported so server actions can call the same helper without
// duplicating the placeholder-vs-Resend branching.
export { sendVerificationEmail };

export const { handlers, auth, signIn, signOut } = NextAuth(fullConfig);
