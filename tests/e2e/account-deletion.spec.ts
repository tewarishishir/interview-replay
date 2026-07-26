import { expect, test, type Page } from "@playwright/test";

import {
  SEED_EMAIL,
  SEED_PASSWORD,
} from "../../src/scripts/seed-fixtures";

/**
 * End-to-end smoke for the account deletion + restore loop.
 *
 *   1. Sign in as the seeded user.
 *   2. Navigate to /account.
 *   3. Click "Delete my account", type the confirmation phrase, submit.
 *   4. Confirm the page navigates to /signin and the auth cookie has
 *      been cleared (the next visit to /account redirects to signin).
 *   5. Sign back in — the credentials path auto-restores accounts
 *      inside the grace window — and confirm we land on /dashboard.
 *
 * The hard-delete cron itself is exercised by the Vitest helpers; this
 * test guards the user-facing flow (UI → API → auth state).
 *
 * The seed user is reset by `tests/e2e/global-setup.ts` between runs,
 * so the soft-delete left behind here doesn't leak into the next
 * `pnpm test:e2e` invocation.
 */

async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel(/^Email$/i).fill(email);
  await page.getByLabel(/^Password$/i).fill(password);
  await page.getByRole("button", { name: /^Sign in$/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 15_000 });
}

test.describe("account deletion flow", () => {
  test("delete → signs out → restore-on-signin brings the account back", async ({
    page,
  }) => {
    await signIn(page, SEED_EMAIL, SEED_PASSWORD);

    await page.goto("/account");
    await expect(
      page.getByRole("heading", { name: /^Account$/i, level: 1 }),
    ).toBeVisible();

    // Reveal the confirmation panel + type the phrase.
    await page
      .getByRole("button", { name: /^Delete my account$/i })
      .click();

    const confirmInput = page.getByLabel(
      /Type DELETE my account to confirm/i,
    );
    await confirmInput.fill("DELETE my account");

    await page
      .getByRole("button", { name: /^Confirm deletion$/i })
      .click();

    // The client redirects to /signin?deletion=initiated after the
    // DELETE /api/me succeeds and the Auth.js cookie is cleared.
    await page.waitForURL(/\/signin(\?|$)/, { timeout: 15_000 });

    // Cookie should be gone — visiting an authenticated route
    // bounces back to signin (the middleware-driven redirect adds
    // ?callbackUrl=).
    await page.goto("/account");
    await page.waitForURL(/\/signin/, { timeout: 5_000 });

    // Sign back in. The credentials path auto-restores the account
    // when it sees a fresh `deletion_requested_at` and lets the
    // session through. We end up on the dashboard, same as a
    // normal sign-in.
    await signIn(page, SEED_EMAIL, SEED_PASSWORD);
    await expect(
      page.getByRole("heading", { name: /^Dashboard$/i, level: 1 }),
    ).toBeVisible();

    // The account page should NOT show the "scheduled for deletion"
    // banner anymore now that we've signed back in.
    await page.goto("/account");
    await expect(
      page.getByText(/will be deleted on/i),
    ).toHaveCount(0);
  });
});
