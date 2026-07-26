-- Forgot-password flow: dedicated single-use tokens.
--
-- Stored in its own table (not the existing `verification_tokens`)
-- so a leaked verification token can never be promoted into a
-- password-reset grant. Same shape as Auth.js's verification_tokens
-- — random UUID, 1h expiry, composite PK on (identifier, token).
-- `identifier` is the user's email.
--
-- No FK to `users.email` because the column isn't unique-indexed
-- as a hard constraint we want to lean on, and an email change
-- mid-reset shouldn't strand a valid token. The completion path
-- looks up the user by email and refuses to write if the user no
-- longer exists.

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "identifier" text NOT NULL,
  "token" text NOT NULL,
  "expires" timestamp with time zone NOT NULL,
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("identifier", "token")
);
