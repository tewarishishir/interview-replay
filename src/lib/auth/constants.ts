/**
 * Auth-related constants safe to import from any runtime (RSC, client,
 * edge, tests). Lives in its own file so the schemas / forms can pull
 * `MIN_PASSWORD_LENGTH` without dragging in `@node-rs/argon2` (which
 * has Node-only native bindings) through `password.ts`.
 */

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

/**
 * Credits granted on first signup (both credentials and OAuth flows).
 *
 * Single source of truth: the credentials path inserts the user row
 * with this exact value AND writes a matching ledger entry inside the
 * same transaction. The Drizzle adapter's `events.createUser` hook
 * (OAuth flows) reads this to mint the matching ledger row after the
 * adapter writes the user.
 *
 * Lives here, not as a Drizzle column default, so:
 *   1. The default in the DB schema and the value in the ledger entry
 *      can never drift (a migration that changes the column default
 *      without updating this constant would be caught in code review,
 *      not at runtime).
 *   2. Backfills / admin tools can read the canonical bonus amount
 *      without having to inspect the live schema.
 *
 * India launch: 2 credits — enough for one full 60-min interview or two
 * 30-min rounds. The grant is once-per-email (the audit log tracks
 * prior signups with the same email; re-signup yields 0). The schema
 * default in `users.ts` matches this value; migration 0023 lowered the
 * column default from 10 to 2 for new rows.
 */
export const SIGNUP_BONUS_CREDITS = 2;
