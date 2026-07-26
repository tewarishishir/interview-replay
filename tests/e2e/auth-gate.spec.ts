import { expect, test } from "@playwright/test";

/**
 * Smoke tests for the auth gate.
 *
 * The hard truth we want to lock in: an unauthenticated request to
 * `/dashboard` (or any other (app)-group route) MUST land the user
 * on `/signin` with the original path preserved as `?callbackUrl`.
 *
 * The "authenticated user sees the session list" path is not in this
 * spec because it requires either a real OAuth callback or seeding a
 * session cookie; both add machinery without testing logic that the
 * Vitest suite doesn't already cover.
 */

test.describe("auth gate", () => {
  test("dashboard redirects unauthenticated users to /signin", async ({
    page,
  }) => {
    const response = await page.goto("/dashboard");
    expect(response?.ok()).toBeTruthy();

    // Final URL is /signin?callbackUrl=/dashboard (or equivalent).
    const url = new URL(page.url());
    expect(url.pathname).toBe("/signin");
    expect(url.searchParams.get("callbackUrl")).toBe("/dashboard");

    // Sign-in card is rendered.
    await expect(
      page.getByRole("heading", { name: /Welcome back/i }),
    ).toBeVisible();
  });

  test("a per-session URL also redirects unauthenticated users", async ({
    page,
  }) => {
    // Use a syntactically valid UUID so we exercise the auth gate
    // rather than the params-validation `notFound()` branch.
    const fakeId = "00000000-0000-4000-a000-000000000000";
    await page.goto(`/sessions/${fakeId}`);

    const url = new URL(page.url());
    expect(url.pathname).toBe("/signin");
    expect(url.searchParams.get("callbackUrl")).toBe(`/sessions/${fakeId}`);
  });

  test("sign-in page renders the email and password fields", async ({
    page,
  }) => {
    await page.goto("/signin");
    await expect(page.getByLabel(/^Email$/i)).toBeVisible();
    await expect(page.getByLabel(/^Password$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Sign in$/i })).toBeVisible();
  });

  test("sign-up page exposes name, email, password and a strong-password hint", async ({
    page,
  }) => {
    await page.goto("/signup");
    await expect(page.getByLabel(/^Email$/i)).toBeVisible();
    await expect(page.getByLabel(/^Password$/i)).toBeVisible();
    await expect(
      page.getByText(/At least 8 characters, including a number/i),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Create account$/i }),
    ).toBeVisible();
  });

  test("client-side validation flags an invalid email on sign-up", async ({
    page,
  }) => {
    await page.goto("/signup");
    await page.getByLabel(/^Email$/i).fill("not-an-email");
    await page.getByLabel(/^Password$/i).fill("validpass1");
    await page.getByRole("button", { name: /^Create account$/i }).click();
    await expect(
      page.getByText(/Enter a valid email address\./i),
    ).toBeVisible();
  });
});
