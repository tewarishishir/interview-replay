import { expect, test, type Page } from "@playwright/test";

import { SEED_EMAIL, SEED_PASSWORD } from "../../src/scripts/seed-fixtures";

/**
 * End-to-end coverage for the `/sessions/new` two-step flow.
 *
 * Verifies, against the running dev server:
 *   1. Auth gate — `/sessions/new` redirects unauthenticated users to
 *      `/signin?callbackUrl=/sessions/new`.
 *   2. Step-1 client validation — pressing "Continue" with empty
 *      fields surfaces inline errors and stays on step 1.
 *   3. Step-2 consent gate — "Start session" is disabled until all
 *      three checkboxes are checked.
 *   4. Happy path — filling step 1, checking all three boxes,
 *      clicking "Start session" lands the user on
 *      `/sessions/{uuid}/record`.
 *
 * Step 4 is the load-bearing assertion. It exercises every layer:
 *   form → server action → Zod validate → DB insert → redirect.
 *
 * The `/sessions/[id]/record` page hasn't been built yet (it ships
 * in the next phase), so we only assert the URL pattern, not the
 * page contents. This test will keep passing when that page lands.
 */

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel(/^Email$/i).fill(SEED_EMAIL);
  await page.getByLabel(/^Password$/i).fill(SEED_PASSWORD);
  await page.getByRole("button", { name: /^Sign in$/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 15_000 });
}

test.describe("/sessions/new auth gate", () => {
  test("redirects unauthenticated users to /signin with callbackUrl", async ({
    page,
  }) => {
    await page.goto("/sessions/new");
    const url = new URL(page.url());
    expect(url.pathname).toBe("/signin");
    expect(url.searchParams.get("callbackUrl")).toBe("/sessions/new");
  });
});

test.describe("/sessions/new form", () => {
  test("step 1 surfaces validation errors and gates the Continue button", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/sessions/new");

    await expect(
      page.getByRole("heading", { name: /Start a new session/i }),
    ).toBeVisible();

    // Click Continue with no inputs filled. RHF + Zod should flag
    // each required field rather than advancing.
    await page.getByRole("button", { name: /^Continue$/i }).click();

    // Still on step 1 — the consent heading from step 2 isn't rendered.
    await expect(
      page.getByRole("heading", { name: /Before you start/i }),
    ).not.toBeVisible();

    // At least one field error is rendered. (We don't pin to exact
    // copy — the messages live in `lib/sessions/schemas.ts` and
    // shouldn't double as a presentation contract.)
    await expect(
      page.getByText(/Too small|required|Invalid input/i).first(),
    ).toBeVisible();
  });

  test("step 2 keeps Start disabled until all three boxes are checked", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/sessions/new");

    // Fill step 1 and advance.
    await page.getByLabel(/Company name/i).fill("InterviewReplay Tech");
    await page.getByLabel(/Role title/i).fill("Senior Software Engineer");
    await page.getByRole("radio", { name: /^Senior$/i }).check();
    await page.getByRole("radio", { name: /^Coding$/i }).check();
    await page.getByRole("button", { name: /^Continue$/i }).click();

    // We are on step 2.
    await expect(
      page.getByRole("heading", { name: /Before you start/i }),
    ).toBeVisible();

    const startButton = page.getByRole("button", { name: /^Start session$/i });
    await expect(startButton).toBeDisabled();

    const checkboxes = page.getByRole("checkbox");
    // Exactly three consent checkboxes on step 2.
    await expect(checkboxes).toHaveCount(3);

    // Toggling a subset doesn't enable the button.
    await checkboxes.nth(0).click();
    await expect(startButton).toBeDisabled();
    await checkboxes.nth(1).click();
    await expect(startButton).toBeDisabled();

    // All three: enabled.
    await checkboxes.nth(2).click();
    await expect(startButton).toBeEnabled();
  });

  test("happy path creates a session and redirects to /sessions/{id}/record", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/sessions/new");

    const stamp = Date.now().toString();
    const company = `E2E Co ${stamp}`;
    const role = `Senior Engineer ${stamp}`;

    await page.getByLabel(/Company name/i).fill(company);
    await page.getByLabel(/Role title/i).fill(role);
    await page.getByRole("radio", { name: /^Senior$/i }).check();
    await page.getByRole("radio", { name: /^System design$/i }).check();
    await page.getByRole("button", { name: /^Continue$/i }).click();

    const checkboxes = page.getByRole("checkbox");
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();
    await checkboxes.nth(2).click();

    await page.getByRole("button", { name: /^Start session$/i }).click();

    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}\/record$/, {
      timeout: 15_000,
    });

    // Quick sanity check that the dashboard now lists the new session.
    // The detail page itself isn't built yet, so we navigate via the
    // dashboard link.
    await page.goto("/dashboard");
    await expect(
      page
        .getByRole("link", { name: `Open session: ${company}`, exact: false })
        .first(),
    ).toBeVisible();
  });
});
