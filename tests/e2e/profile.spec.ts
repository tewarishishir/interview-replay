import { expect, test, type Page } from "@playwright/test";

import { SEED_EMAIL, SEED_PASSWORD } from "../../src/scripts/seed-fixtures";

/**
 * End-to-end coverage for `/profile`.
 *
 * Verifies, against the running dev server:
 *   1. Auth gate — `/profile` redirects unauthenticated users to
 *      `/signin?callbackUrl=/profile`.
 *   2. The four collapsible sections are present.
 *   3. Manual "skip upload, fill manually" → save round-trips
 *      values into Postgres (the next page load shows them).
 *   4. Adding a project surfaces in the projects section.
 *   5. Adding a story under a theme surfaces in the right group.
 *   6. The exclude-from-analysis switch toggles + persists.
 *
 * Resume PDF parsing is not exercised end-to-end here — the worker
 * needs LLM provider + local storage wired up. The vitest suite covers the
 * upload + draft + save flow with mocked job runner.
 */

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel(/^Email$/i).fill(SEED_EMAIL);
  await page.getByLabel(/^Password$/i).fill(SEED_PASSWORD);
  await page.getByRole("button", { name: /^Sign in$/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 15_000 });
  // The redirect is fast but the auth cookie is set as part of the
  // 303 from /signin — wait for the dashboard's network to settle so
  // the cookie is in the jar by the time the next `goto` runs the
  // middleware. Without this the next /profile navigation can fire
  // before the Set-Cookie has been applied and middleware bounces
  // us back to /signin.
  await page.waitForLoadState("networkidle");
}

test.describe("/profile auth gate", () => {
  test("redirects unauthenticated users to /signin with callbackUrl", async ({
    page,
  }) => {
    await page.goto("/profile");
    const url = new URL(page.url());
    expect(url.pathname).toBe("/signin");
    expect(url.searchParams.get("callbackUrl")).toBe("/profile");
  });
});

test.describe("/profile sections", () => {
  test("renders all four collapsible sections + the completeness banner", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/profile");

    await expect(
      page.getByRole("heading", { name: /^Profile$/i }),
    ).toBeVisible();
    await expect(page.getByText(/Profile completeness/i)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Resume import$/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Projects$/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Behavioral story bank$/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Target context$/i }),
    ).toBeVisible();
  });

  test("manual resume fill — save persists across navigation", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/profile");

    // Reveal manual fill if the form isn't already showing.
    const skipLink = page.getByRole("button", {
      name: /Skip upload, fill manually/i,
    });
    if (await skipLink.isVisible().catch(() => false)) {
      await skipLink.click();
    }

    const stamp = Date.now().toString().slice(-6);
    const role = `Staff Engineer ${stamp}`;

    await page.getByLabel(/Years of experience/i).fill("9");
    await page.getByLabel(/Current role/i).fill(role);

    // Click + wait for the PATCH to land before reloading. Without
    // this the reload races the in-flight request and the test sees
    // a still-empty profile on the next render.
    const saveResponse = page.waitForResponse(
      (r) => r.url().endsWith("/api/profile") && r.request().method() === "PATCH",
    );
    await page
      .getByRole("button", { name: /^Save resume$/i })
      .click();
    const r = await saveResponse;
    expect(r.status()).toBe(200);

    await page.reload();
    await expect(page.getByLabel(/Years of experience/i)).toHaveValue("9");
    await expect(page.getByLabel(/Current role/i)).toHaveValue(role);
    await expect(page.getByText(/Resume saved/i)).toBeVisible();
  });

  test("target context — checking levels + saving narrative persists", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/profile");

    // Levels: check Senior + Staff.
    await page.getByRole("checkbox", { name: /^Senior$/i }).check();
    await page.getByRole("checkbox", { name: /^Staff$/i }).check();

    const stamp = Date.now().toString().slice(-6);
    const narrative =
      `I am a backend engineer with 8 years of experience. ${stamp}`;
    await page.getByLabel(/Career narrative/i).fill(narrative);

    const targetSave = page.waitForResponse(
      (r) => r.url().endsWith("/api/profile") && r.request().method() === "PATCH",
    );
    await page
      .getByRole("button", { name: /^Save target context$/i })
      .click();
    const tr = await targetSave;
    expect(tr.status()).toBe(200);

    await page.reload();

    // After reload, the form is hydrated with the saved values.
    await expect(
      page.getByRole("checkbox", { name: /^Senior$/i }),
    ).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: /^Staff$/i }),
    ).toBeChecked();
    await expect(page.getByLabel(/Career narrative/i)).toHaveValue(narrative);
  });

  test("add project flow — new project shows up after reload", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/profile");

    const stamp = Date.now().toString().slice(-6);
    const projectName = `E2E Project ${stamp}`;

    await page
      .getByRole("button", { name: /^Add project$/i })
      .first()
      .click();

    await page.getByLabel(/^Name$/i).fill(projectName);
    await page.getByLabel(/Company \/ context/i).fill("Stripe — Payments");
    await page.getByLabel(/^Outcomes with metrics$/i).fill(
      "Reduced p99 latency from 380ms to 110ms.",
    );

    const projectCreate = page.waitForResponse(
      (r) => r.url().endsWith("/api/projects") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: /^Add project$/i })
      .last()
      .click();
    const pr = await projectCreate;
    expect(pr.status()).toBe(201);

    await page.reload();
    await expect(
      page.getByText(new RegExp(projectName)),
    ).toBeVisible();
  });

  test("add story flow — story shows up under its theme", async ({ page }) => {
    await signIn(page);
    await page.goto("/profile");

    const stamp = Date.now().toString().slice(-6);
    const storyTitle = `Pushed back on plan ${stamp}`;

    // First "Add story" trigger is for the first themed group
    // (Leadership conflict). Clicking it opens an inline form.
    await page
      .getByRole("button", { name: /^Add story$/i })
      .first()
      .click();

    // The form is the only form on the page right now — scope all
    // form lookups through it so we don't pick up the still-rendered
    // "+ Add story" trigger buttons for the other ten themes.
    const form = page.locator("form");
    await form.getByLabel(/^Title$/i).fill(storyTitle);
    await form.getByLabel(/^Situation$/i).fill(
      "We had a quarterly plan that was missing a critical migration.",
    );

    const storyCreate = page.waitForResponse(
      (r) => r.url().endsWith("/api/stories") && r.request().method() === "POST",
    );
    await form
      .getByRole("button", { name: /^Add story$/i })
      .click();
    const sr = await storyCreate;
    expect(sr.status()).toBe(201);

    await page.reload();
    await expect(page.getByText(storyTitle)).toBeVisible();
  });

  test("exclude-from-analysis switch toggles and persists", async ({ page }) => {
    await signIn(page);
    await page.goto("/profile");

    const switchEl = page.getByRole("switch", {
      name: /Exclude Resume import from analysis/i,
    });
    await expect(switchEl).toHaveAttribute("aria-checked", "false");

    const toggle = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/profile/exclude") &&
        r.request().method() === "PATCH",
    );
    await switchEl.click();
    const tr = await toggle;
    expect(tr.status()).toBe(200);

    await expect(switchEl).toHaveAttribute("aria-checked", "true");

    await page.reload();
    await expect(
      page.getByRole("switch", {
        name: /Exclude Resume import from analysis/i,
      }),
    ).toHaveAttribute("aria-checked", "true");

    // Reset for cleanliness — toggling back keeps the seed user
    // re-runnable across iterations.
    const untoggle = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/profile/exclude") &&
        r.request().method() === "PATCH",
    );
    await page
      .getByRole("switch", {
        name: /Exclude Resume import from analysis/i,
      })
      .click();
    await untoggle;
  });
});
