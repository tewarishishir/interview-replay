/**
 * Seed credentials accounts for the closed-beta cohort.
 *
 * Creates N (default 10) credentials users with strong random
 * passwords, marks them email-verified (so they skip the verify-email
 * gate), and writes the cleartext credentials to a gitignored file under
 * `tmp/beta-credentials.txt` so the operator can share them through a
 * secure channel (1Password share, Bitwarden Send, etc.).
 *
 * Run with:
 *   BETA_SEED_CONFIRM=yes pnpm exec tsx \
 *     --conditions=react-server --env-file=.env.local \
 *     src/scripts/seed-beta-users.ts
 *
 * The `BETA_SEED_CONFIRM` gate exists because this script writes to
 * whatever DATABASE_URL is configured — i.e. it will happily hit
 * production if you pass `--env-file=.env.production`. The confirm-env
 * pattern matches the friction in `promote-admin.ts` and keeps an
 * accidental `tsx src/scripts/seed-beta-users.ts` from creating
 * surprise rows.
 *
 * Idempotent: re-running skips emails that already exist. The script
 * does NOT touch existing rows (no password reset).
 * To rotate a beta password, delete the user first and re-run.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { db, schema } from "../lib/db";
import { hashPassword } from "../lib/auth/password";

const BETA_USER_COUNT = 10;
const BETA_EMAIL_DOMAIN = "localhost:3000";
const BETA_EMAIL_PREFIX = "beta-tester";
const OUTPUT_DIR = "tmp";
const OUTPUT_FILENAME = "beta-credentials.txt";

const PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const PASSWORD_LENGTH = 16;

/**
 * Cryptographically random password from a deliberately limited
 * alphabet. We skip visually ambiguous characters (`0/O`, `1/l/I`) so
 * the credential can be read off a screen + typed without
 * second-guessing. The signup action's schema requires at least one
 * digit; we force one explicitly rather than relying on the random
 * draw.
 */
function generatePassword(): string {
  const chars: string[] = [];
  // Force one digit so we always satisfy the `passwordSchema` regex.
  const digits = "23456789";
  chars.push(digits[randomBytes(1)[0]! % digits.length]!);

  while (chars.length < PASSWORD_LENGTH) {
    const idx = randomBytes(1)[0]! % PASSWORD_ALPHABET.length;
    chars.push(PASSWORD_ALPHABET[idx]!);
  }

  // Fisher–Yates shuffle so the forced digit isn't always position 0.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }

  return chars.join("");
}

function emailFor(n: number): string {
  return `${BETA_EMAIL_PREFIX}-${String(n).padStart(2, "0")}@${BETA_EMAIL_DOMAIN}`;
}

interface SeedResult {
  email: string;
  password: string | null;
  status: "created" | "exists";
}

async function seedOne(n: number): Promise<SeedResult> {
  const email = emailFor(n);

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing) {
    return { email, password: null, status: "exists" };
  }

  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.users)
      .values({
        email,
        name: `Beta Tester ${String(n).padStart(2, "0")}`,
        passwordHash,
        emailVerified: new Date(),
      })
      .returning({ id: schema.users.id });

    if (!created) {
      throw new Error(`seedBetaUsers: INSERT returned no row for ${email}`);
    }

    await tx.insert(schema.auditLog).values({
      eventType: "auth.signup",
      eventData: {
        email,
        user_id: created.id,
        source: "beta_seed_script",
      },
    });
  });

  return { email, password, status: "created" };
}

async function main(): Promise<void> {
  if (process.env.BETA_SEED_CONFIRM !== "yes") {
    console.error(
      "Refusing to run without BETA_SEED_CONFIRM=yes.\n" +
        "This script writes to whatever DATABASE_URL is configured " +
        "(possibly production). Re-run as:\n\n" +
        "  BETA_SEED_CONFIRM=yes pnpm exec tsx \\\n" +
        "    --conditions=react-server --env-file=.env.local \\\n" +
        "    src/scripts/seed-beta-users.ts\n",
    );
    process.exit(2);
  }

  const results: SeedResult[] = [];
  for (let i = 1; i <= BETA_USER_COUNT; i++) {
    results.push(await seedOne(i));
  }

  const created = results.filter((r) => r.status === "created");
  const skipped = results.filter((r) => r.status === "exists");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = join(OUTPUT_DIR, OUTPUT_FILENAME);

  const lines: string[] = [
    "# InterviewReplay closed-beta credentials",
    `# Generated: ${new Date().toISOString()}`,
    "#",
    "# DO NOT COMMIT THIS FILE. It is gitignored under tmp/.",
    "# Share each pair with one tester via a secure channel",
    "# (1Password share, Bitwarden Send, signal, etc.), then delete",
    "# this file once distribution is complete.",
    "",
  ];

  if (created.length === 0 && skipped.length > 0) {
    lines.push("All beta accounts already exist. No new credentials issued.");
    lines.push("");
  } else {
    for (const r of created) {
      lines.push(`${r.email}\t${r.password}`);
    }
  }

  if (skipped.length > 0) {
    lines.push("");
    lines.push("# Existing accounts (skipped):");
    for (const r of skipped) {
      lines.push(`# - ${r.email}`);
    }
  }

  writeFileSync(outputPath, lines.join("\n") + "\n", { mode: 0o600 });

  // CLI output. The project's lint config restricts console to
  // warn/error; warn is the closest allowed sink that still surfaces
  // in the operator's terminal.
  console.warn(
    `Seeded ${created.length} new beta accounts (${skipped.length} already existed).`,
  );
  console.warn(`Credentials written to ${outputPath} (mode 0600).`);
  console.warn("Share each pair via a secure channel, then delete the file.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
