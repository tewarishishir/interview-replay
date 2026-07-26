/**
 * Flip the `users.is_admin` flag for the user with the given email.
 *
 * Run with:
 *   pnpm exec tsx --conditions=react-server --env-file=.env.local \
 *     src/scripts/promote-admin.ts founder@example.com
 *
 * Or, in dev where the npm script is wired up, add this to
 * package.json scripts and call `pnpm run admin:promote -- email@…`.
 *
 * The script is intentionally separate from the seed flow: making
 * someone an admin is an irreversible-in-effect privilege escalation
 * (they can read every user's payment history) and bundling it into
 * the seed would either run unintentionally OR force every test
 * fixture to make decisions about admin state. Keeping it explicit
 * means promotion is always a deliberate command in your shell
 * history.
 *
 * Pass `--demote` to flip the flag back to false. Useful when an
 * admin's responsibilities change or you're testing the redirect-to-
 * /dashboard path the (admin) layout takes for non-admins.
 *
 * The script refuses to run if the resolved email isn't found — it
 * does NOT create the user. If you need an admin user from scratch,
 * sign them up through the normal flow first, then run this.
 *
 * No production guardrail (no env check, no `--yes` prompt) — this
 * runs in whatever DATABASE_URL is set. The friction of typing
 * `tsx … --env-file=.env.production` is the v1 safety story; if
 * the team grows past one admin we add a confirmation.
 */

import { eq, sql } from "drizzle-orm";

import { db, schema } from "../lib/db";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const demote = args.includes("--demote");
  const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();

  if (!email) {
    console.error("usage: promote-admin <email> [--demote]");
    process.exit(2);
  }

  const targetValue = !demote;
  const action = demote ? "demoted" : "promoted";

  const result = await db
    .update(schema.users)
    .set({ isAdmin: targetValue, updatedAt: new Date() })
    .where(eq(sql`lower(${schema.users.email})`, email))
    .returning({
      id: schema.users.id,
      email: schema.users.email,
      isAdmin: schema.users.isAdmin,
    });

  if (result.length === 0) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }

  for (const row of result) {
    // CLI output — the project's lint config restricts console to
    // warn/error, but the operator needs human-readable confirmation
    // of what just changed in the DB. `console.warn` is the closest
    // allowed sink that still surfaces in their terminal.
    console.warn(`${action} ${row.email} (id=${row.id}) → is_admin=${row.isAdmin}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
