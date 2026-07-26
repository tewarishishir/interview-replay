/**
 * Create a single admin user with a given email (and optional name),
 * or promote an existing user to admin.
 *
 * Run with:
 *   DATABASE_URL=<url> pnpm exec tsx --conditions=react-server \
 *     src/scripts/create-admin-user.ts admin@example.com "Display Name"
 *
 * - Idempotent: if the user already exists they are promoted and their
 *   password is NOT reset. The generated password is only printed when
 *   the account is freshly created.
 * - The user is marked email-verified so they can log in immediately.
 * - No signup credits are granted (admin accounts aren't end-users).
 */

import { eq, sql } from "drizzle-orm";

import { db, schema } from "../lib/db";
import { hashPassword } from "../lib/auth/password";
import { setReferralCodeOnTx } from "../lib/referrals";

const PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const PASSWORD_LENGTH = 20;

function generatePassword(): string {
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  const chars: string[] = [];
  const digits = "23456789";
  chars.push(digits[randomBytes(1)[0]! % digits.length]!);
  while (chars.length < PASSWORD_LENGTH) {
    const idx = randomBytes(1)[0]! % PASSWORD_ALPHABET.length;
    chars.push(PASSWORD_ALPHABET[idx]!);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

async function main(): Promise<void> {
  const [emailArg, nameArg] = process.argv.slice(2);
  const email = emailArg?.trim().toLowerCase();

  if (!email) {
    console.error('usage: create-admin-user <email> ["Display Name"]');
    process.exit(2);
  }

  const name = nameArg?.trim() ?? email.split("@")[0] ?? "Admin";

  const [existing] = await db
    .select({ id: schema.users.id, email: schema.users.email, isAdmin: schema.users.isAdmin })
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.email})`, email))
    .limit(1);

  if (existing) {
    if (existing.isAdmin) {
      console.warn(`already exists and is already admin: ${existing.email} (id=${existing.id})`);
      process.exit(0);
    }

    // Promote existing user
    await db
      .update(schema.users)
      .set({ isAdmin: true, updatedAt: new Date() })
      .where(eq(schema.users.id, existing.id));

    console.warn(`promoted existing user to admin: ${existing.email} (id=${existing.id})`);
    console.warn("password was NOT changed — use the existing password or reset via the app.");
    process.exit(0);
  }

  // Create new user
  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.users)
      .values({
        email,
        name,
        passwordHash,
        emailVerified: new Date(),
        isAdmin: true,
        creditBalance: 0,
      })
      .returning({ id: schema.users.id });

    if (!created) throw new Error("INSERT returned no row");

    await tx.insert(schema.auditLog).values({
      eventType: "auth.signup",
      eventData: {
        email,
        user_id: created.id,
        credits_granted: 0,
        source: "create_admin_user_script",
      },
    });

    await setReferralCodeOnTx(tx, created.id);

    console.warn(`created admin user: ${email} (id=${created.id})`);
    console.warn(`password: ${password}`);
    console.warn("Store this password in 1Password — it will not be shown again.");
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
