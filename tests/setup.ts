/**
 * Vitest global setup.
 *
 * - Loads `.env.local` so `DATABASE_URL` is available to tests without
 *   the developer having to wire dotenv into every test file.
 * - Refuses to run if `DATABASE_URL` doesn't look local — these tests
 *   destroy data and should never touch a remote DB.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });

// Allow TEST_DATABASE_URL to override .env.local for local test runs
// against a dedicated test database without modifying .env.local.
// CI sets DATABASE_URL directly (no .env.local); this escape hatch is
// only needed locally when .env.local points at a remote instance.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const url = process.env.DATABASE_URL ?? "";
const isLocal = /@(localhost|127\.0\.0\.1)[:\/]/.test(url);

if (!isLocal && process.env.ALLOW_REMOTE_TEST_DB !== "1") {
  throw new Error(
    `Refusing to run DB tests against non-local DATABASE_URL (${url || "<unset>"}).\n` +
      "Start the local Postgres (docker compose up -d postgres) or set " +
      "ALLOW_REMOTE_TEST_DB=1.",
  );
}
