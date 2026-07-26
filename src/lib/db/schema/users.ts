import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

/**
 * Auth.js (NextAuth v5) + InterviewReplay unified user record.
 *
 * Notes for the column shapes the spec called out:
 * - `email_verified` is stored as TIMESTAMPTZ (NULL = unverified, non-NULL =
 *   verified-at). The product-level "is the email verified?" check is
 *   `emailVerified !== null`. We can't make this a literal boolean column
 *   because `@auth/drizzle-adapter` writes a Date here when the OAuth
 *   provider confirms the email — its `User` type is `emailVerified: Date | null`.
 * - The Drizzle field `name` maps to SQL column `display_name` so the spec's
 *   table layout is respected, while the adapter (which only sees the TS
 *   field name) keeps writing OAuth display names through the same column.
 * - We keep `image` (mapped to `image_url`) only because the adapter writes
 *   the OAuth avatar there. Nothing else in the app reads it yet.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    name: text("display_name"),

    email: text("email").notNull(),

    emailVerified: timestamp("email_verified", {
      mode: "date",
      withTimezone: true,
    }),

    image: text("image_url"),

    passwordHash: text("password_hash"),

    /**
     * ISO 3166-1 alpha-2 country code derived from the signup IP via
     * MaxMind GeoIP. Used by the weekly geography report and the
     * India-only abuse-triage runbook. Nullable: the lookup is
     * best-effort (the database file may be missing, or the IP may
     * be private/local in dev) and we don't want to block signup on
     * geography resolution.
     */
    signupCountryCode: text("signup_country_code"),

    /**
     * ISO 3166-2 subdivision code (e.g. `MH` for Maharashtra, `KA`
     * for Karnataka, `CA` for California). Stored WITHOUT the
     * country prefix — the full ISO-3166-2 string would be
     * `IN-MH` but we only persist the suffix because the country
     * already lives on `signup_country_code` and the prefix is
     * always implied by it.
     *
     * Populated from MaxMind GeoLite2-City's `subdivisions[0].isoCode`
     * field. Null when:
     *   - the operator only has GeoLite2-Country installed (subdivision
     *     data lives only in the larger City DB),
     *   - the IP is reserved/private,
     *   - MaxMind has no subdivision data for the IP (some smaller
     *     countries don't subdivide in the GeoLite catalog).
     *
     * The admin Users surface displays this as "Maharashtra, IN"
     * when present and falls back to "IN" when null — never
     * "Unknown, IN", because the absence of subdivision data
     * carries no operational signal.
     */
    signupSubdivisionCode: text("signup_subdivision_code"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    deletedAt: timestamp("deleted_at", { withTimezone: true }),

    /**
     * 30-day grace clock starts here. Set when the user requests
     * deletion via DELETE /api/me; cleared if they sign back in
     * within the window via POST /api/me/restore. The hard-delete
     * cron picks rows where this is older than 30 days.
     *
     * Distinct from `deletedAt`, which is the actual soft-delete
     * marker. Splitting the two lets us tell "we promised to delete
     * you, here's the timer" apart from "you are deleted, the
     * cookie is dead". In practice both are stamped at the same
     * time during the initiate path; the cron only cares about
     * `deletionRequestedAt` so a manual `deletedAt` (admin
     * lockout / abuse) doesn't accidentally enter the hard-delete
     * pipeline.
     */
    deletionRequestedAt: timestamp("deletion_requested_at", {
      withTimezone: true,
    }),

    /**
     * When the user last accepted the current Terms of Service.
     * Compared against `TERMS_VERSION_DATE` to drive the
     * "we've updated our Terms" banner that gates the (app) shell.
     * NULL = never accepted (legacy account from before launch);
     * a date older than the current TOS effective date forces re-
     * acceptance on the next sign-in.
     */
    termsAcceptedAt: timestamp("terms_accepted_at", {
      withTimezone: true,
    }),

    /**
     * Founder/operator admin flag. Gates access to the `(admin)` route
     * group (Daily Ops dashboard, Users view, Product Health view). The
     * admin layout reads this column on every request — no JWT caching —
     * because a revoked admin must lose access immediately, not at the
     * next token rotation.
     *
     * Default is `false` for every new signup. There is no in-app path
     * to flip this; promotion is a manual SQL update or the
     * `scripts/promote-admin.ts` helper. That intentional friction is the
     * v1 access-control story: until there are two or more admins, a
     * per-row boolean is cheaper than a role table and harder to
     * misconfigure than a hardcoded email allowlist.
     */
    isAdmin: boolean("is_admin").notNull().default(false),

    /**
     * UI theme preference. One of:
     *   - `'system'` (default): follow the OS-level
     *     `prefers-color-scheme` media query, resolved client-side
     *     on each load.
     *   - `'light'` / `'dark'`: explicit override, persisted so the
     *     user's choice follows them across devices.
     *
     * Stored as a text column (not an enum) because the set is
     * tiny + stable and the API endpoint already validates against
     * a Zod literal union. An enum would force a destructive type
     * rewrite if we ever add a fourth mode (e.g. `'high-contrast'`).
     *
     * The CHECK constraint `users_theme_preference_value` pins the
     * column to the three known values so a buggy write path can't
     * land an unrecognized string the front-end then renders as a
     * blank theme.
     */
    themePreference: text("theme_preference").notNull().default("system"),
  },
  (table) => [
    uniqueIndex("users_email_key").on(table.email),
    // Newest-first signup scan for the admin Ops dashboard
    // (today/yesterday metrics, 7-day trend, 30-day funnel). Partial
    // on `deleted_at IS NULL` so the dashboard never has to filter
    // soft-deleted rows out of an index range scan.
    index("users_created_at_idx")
      .on(table.createdAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),
    // Geo dashboard tile + non-Indian signup health check. Partial
    // on `deleted_at IS NULL` for the same reason as above.
    index("users_signup_country_idx")
      .on(table.signupCountryCode)
      .where(sql`${table.deletedAt} IS NULL`),
    // Tiny partial index for the per-request admin-gate lookup
    // (`SELECT is_admin WHERE id = $1`). Hot path on every
    // /admin/* request, so we want it cheap; with only one or two
    // admin rows the index is effectively a single page.
    index("users_admin_lookup_idx")
      .on(table.isAdmin)
      .where(sql`${table.isAdmin} = true`),
    // Pin theme_preference to the three values the app actually
    // understands. Anything else would render as a blank theme in
    // the layout's data-theme attribute. Application code validates
    // first, but the CHECK is the load-bearing backstop.
    check(
      "users_theme_preference_value",
      sql`${table.themePreference} IN ('light', 'dark', 'system')`,
    ),
  ],
);

/**
 * Auth.js OAuth account linkage. Field names (camelCase / snake_case) are
 * dictated by `@auth/drizzle-adapter`; do not rename them.
 */
export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({
      columns: [account.provider, account.providerAccountId],
      name: "accounts_pkey",
    }),
  ],
);

/**
 * Auth.js database-session table. We're on the JWT strategy today so this
 * table is unused at runtime, but the adapter requires it to exist for
 * verification flows that fall back to DB sessions.
 *
 * Spelled `auth_sessions` so it doesn't collide with our domain table
 * `interview_sessions`.
 */
export const authSessions = pgTable("auth_sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
  },
  (vt) => [
    primaryKey({
      columns: [vt.identifier, vt.token],
      name: "verification_tokens_pkey",
    }),
  ],
);

/**
 * Password-reset tokens. Same shape as `verification_tokens` — a
 * random UUID stamped at request time, expiring after one hour —
 * but stored in its own table so a verification token can never be
 * misused as a reset token (different authorization grant).
 *
 * Doubles as the path for Google-OAuth signups (where
 * `users.password_hash IS NULL`) to set a first password: the
 * completion handler writes the hash regardless of whether the
 * column was previously null or held a prior bcrypt/argon2 hash.
 *
 * `identifier` is the user's email. Composite PK on (identifier,
 * token) mirrors the Auth.js convention `verification_tokens` uses,
 * so the same rotate-on-resend pattern applies: when a user clicks
 * "forgot password" twice, the second click deletes the first row
 * before inserting the new one.
 */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.identifier, t.token],
      name: "password_reset_tokens_pkey",
    }),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
