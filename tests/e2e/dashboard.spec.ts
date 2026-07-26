import { expect, test, type Page } from "@playwright/test";

import {
  SEED_EMAIL,
  SEED_PASSWORD,
  sampleSessions,
} from "../../src/scripts/seed-fixtures";

/**
 * Authenticated dashboard test.
 *
 * Drives the full sign-in flow through the UI (no cookie injection)
 * using the credentials seeded by `tests/e2e/global-setup.ts`. After
 * landing on `/dashboard` the test asserts:
 *
 *  - All seeded sessions render as cards
 *  - At least one card has the "Completed" status pill (Acme + Stripe
 *    are seeded `completed`)
 *  - Clicking a session card navigates to `/sessions/{id}`
 *
 * Seed constants are imported directly from the seed script so any
 * change to companies/etc. updates both the seed and this test
 * in lockstep — no silent drift between fixture and assertion.
 */

const seededCompanies = sampleSessions.map((s) => s.companyName);

/**
 * Submit credentials and return as soon as the server has either
 * redirected us to the dashboard OR rendered an in-form error. Without
 * this race, a seed mismatch would cause `waitForURL("**\/dashboard")`
 * to time out for the full 15s with the misleading message
 * "URL didn't match" — this surfaces "we ended up back on signin"
 * fast and clearly.
 */
async function signInAndAwaitDashboard(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel(/^Email$/i).fill(email);
  await page.getByLabel(/^Password$/i).fill(password);
  await page.getByRole("button", { name: /^Sign in$/i }).click();

  // Filter for alerts that have non-whitespace text. Without this,
  // the empty `role="alert"` portal Next.js Dev Tools mounts in dev
  // mode is matched immediately on every page (including /dashboard
  // post-redirect), and the race never reaches the URL branch.
  const errorAlert = page
    .getByRole("alert")
    .filter({ hasText: /\S/ })
    .first();

  const dashboardWait = page
    .waitForURL("**/dashboard", { timeout: 15_000 })
    .then(() => "dashboard" as const);
  const alertWait = errorAlert
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => "alert" as const);

  const outcome = await Promise.race([dashboardWait, alertWait]);
  if (outcome === "alert") {
    const message = await errorAlert.textContent().catch(() => null);
    throw new Error(
      `Sign-in did not land on /dashboard. The signin page rendered an alert ` +
        `(${message?.trim() ?? "<no text>"}). The most common cause is the ` +
        `seed not running — verify global-setup ran and that the seeded ` +
        `password matches SEED_PASSWORD in src/scripts/seed-fixtures.ts.`,
    );
  }
}

test.describe("authenticated dashboard", () => {
  test("signs in and shows the seeded session list", async ({ page }) => {
    await signInAndAwaitDashboard(page, SEED_EMAIL, SEED_PASSWORD);

    await expect(
      page.getByRole("heading", { name: /^Dashboard$/i, level: 1 }),
    ).toBeVisible();

    // Every seeded session renders. Using Playwright's plain-string
    // `name` (with `exact: false`) instead of `new RegExp(...)` so a
    // future company name that happens to contain regex metachars
    // (e.g. "37signals (Inc.)") doesn't silently mis-match or throw.
    for (const company of seededCompanies) {
      await expect(
        page.getByRole("link", { name: `Open session: ${company}`, exact: false }),
      ).toBeVisible();
    }

    // At least one card surfaces the "Complete" pill (Acme + Stripe).
    await expect(page.getByText("Complete", { exact: true }).first()).toBeVisible();

    // Clicking a card lands on a /sessions/{uuid} URL.
    const firstCompany = seededCompanies[0];
    if (!firstCompany) throw new Error("seed must have at least one session");
    await page
      .getByRole("link", { name: `Open session: ${firstCompany}`, exact: false })
      .click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 5_000 });
    await expect(
      page.getByRole("link", { name: /Back to dashboard/i }),
    ).toBeVisible();
  });
});
