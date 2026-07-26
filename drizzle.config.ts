import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// If DATABASE_URL was passed explicitly on the CLI (e.g. for production
// migrations: DATABASE_URL=... npm run db:migrate), honour it as-is.
// Only fall back to .env files when no URL was pre-set, so that .env.local
// never silently overrides an intentional production target.
const hasCLIUrl = !!process.env.DATABASE_URL;
if (!hasCLIUrl) {
  // Next.js layers .env.local on top of .env; drizzle-kit doesn't, so we
  // do it explicitly here. Order matters: .env.local wins.
  loadEnv({ path: ".env" });
  loadEnv({ path: ".env.local", override: true });
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
  );
}

// Safety guard: `drizzle-kit push` reconciles the live DB to the schema
// and can DROP columns/tables to do so. It must NEVER run against
// staging or production (see .cursor/rules/schema-safety.mdc). Because
// .env.local can legitimately point at a remote DB, a stray
// `npm run db:push` would otherwise reconcile PRODUCTION. Hard-block it
// unless the target is local — deliberate remote schema changes go
// through `npm run db:migrate` (pending SQL files only, never drops).
if (process.env.DRIZZLE_COMMAND === "push") {
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  if (!isLocal && process.env.ALLOW_REMOTE_DB_PUSH !== "1") {
    throw new Error(
      "Refusing to run `drizzle-kit push` against a non-local database:\n" +
        `  ${url.replace(/:[^:@/]+@/, ":****@")}\n\n` +
        "`push` can DROP columns/tables to reconcile schema drift. Use " +
        "`npm run db:migrate` (applies only the pending SQL in drizzle/) " +
        "to change a remote schema. If you REALLY mean to push to this " +
        "target, re-run with ALLOW_REMOTE_DB_PUSH=1.",
    );
  }
}

export default defineConfig({
  schema: "./src/lib/db/schema/*.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
