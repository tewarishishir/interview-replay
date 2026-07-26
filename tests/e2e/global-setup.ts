/**
 * Playwright global setup.
 *
 * Runs once before any e2e test. Currently it just re-runs the local
 * dev seed so the suite can rely on a known starting state — one user
 * (`SEED_EMAIL` / `SEED_PASSWORD` from `src/scripts/seed.ts`) with
 * the sample interview sessions defined there.
 *
 * The seed itself is idempotent and refuses to run against non-local
 * DATABASE_URLs, so this is safe to leave wired in unconditionally.
 *
 * Side effect to note: re-running the seed wipes `interview_sessions`
 * for the seed user. If a developer was hand-poking the dashboard
 * with custom rows for `test@interview-replay.local`,
 * `pnpm test:e2e` will clear them.
 */
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;
const BASE_URL = `http://localhost:${PORT}`;

// We use `process.cwd()` here even though it's implicit-Playwright
// behavior: `globalSetup` files are compiled to CJS by Playwright's
// loader, which makes `import.meta.url` throw at runtime. The
// alternative — `__dirname` — would lint-fail under our ESM-targeted
// tsconfig. `cwd()` is safe because Playwright always launches from
// the project root; the pre-flight checks below convert any drift
// into an actionable error rather than a deep stack.
const ROOT = process.cwd();

const TSX = path.resolve(ROOT, "node_modules", ".bin", "tsx");
const SEED = path.resolve(ROOT, "src", "scripts", "seed.ts");
const ENV_FILE = path.resolve(ROOT, ".env.local");

export default async function globalSetup(): Promise<void> {
  // Pre-flight: surface the two failures contributors hit most often
  // with messages they can act on, instead of a deep stack from the
  // seed or env validator.
  if (!existsSync(ENV_FILE)) {
    throw new Error(
      "[playwright/global-setup] .env.local is missing. Copy it from " +
        ".env.example and set AUTH_SECRET (run `openssl rand -base64 32`).",
    );
  }
  if (!existsSync(TSX)) {
    throw new Error(
      "[playwright/global-setup] node_modules/.bin/tsx is missing. " +
        "Run `pnpm install` first.",
    );
  }
  if (!existsSync(SEED)) {
    // Catches both "wrong cwd" and "someone moved the seed script".
    throw new Error(
      `[playwright/global-setup] seed script not found at ${SEED}. ` +
        "Was Playwright invoked from outside the project root?",
    );
  }

  // 30s budget: the script hashes a password with argon2id (~200ms) and
  // does a handful of small inserts, so this is generous.
  //
  // `--conditions=react-server` makes the `server-only` runtime guard
  // (imported transitively via `lib/auth/password.ts`) resolve to its
  // no-op `empty.js`, the same way Next.js handles it. Without it,
  // the package throws "This module cannot be imported from a Client
  // Component module" the moment `password.ts` loads, because the
  // default condition resolves to the throwing entrypoint.
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileAsync(
      TSX,
      ["--conditions=react-server", "--env-file=.env.local", SEED],
      { cwd: ROOT, timeout: 30_000 },
    ));
  } catch (err) {
    // execFile rejects with an Error that has stdout/stderr attached
    // when the child exits non-zero. Surface them in the thrown
    // message so Playwright's failure log shows the actual seed
    // error rather than a bare exit code.
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    const tail = (s: string | undefined): string =>
      (s ?? "").trim().split("\n").slice(-15).join("\n");
    throw new Error(
      "[playwright/global-setup] seed failed (" +
        (e.code ?? "unknown") +
        ").\n" +
        "stdout:\n" +
        tail(e.stdout) +
        "\nstderr:\n" +
        tail(e.stderr),
    );
  }

  if (stdout.trim()) {
    // eslint-disable-next-line no-console
    console.log("[playwright/global-setup] seed:\n" + stdout.trim());
  }
  if (stderr.trim()) {
    console.warn("[playwright/global-setup] seed stderr:\n" + stderr.trim());
  }

  // Write a storageState file that pre-seeds the analytics consent
  // banner choice ("declined") in localStorage. The cookie banner
  // is fixed-position and intercepts pointer events until the user
  // makes a choice; without this every test's first click races
  // against it. Pre-declining is the right test-time default
  // (privacy-respecting analytics is opt-in, and tests don't need
  // analytics wired up). The file is rewritten on every run so it
  // survives `git clean -fdx` workflows.
  const STATE_FILE = path.resolve(ROOT, "tests", "e2e", ".storage-state.json");
  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        cookies: [],
        origins: [
          {
            origin: BASE_URL,
            localStorage: [
              { name: "ir-analytics-consent", value: "declined" },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
}
