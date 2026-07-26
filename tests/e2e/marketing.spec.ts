import { expect, test } from "@playwright/test";

/**
 * Smoke tests for the public marketing surface. These don't go deep —
 * they assert that each page reaches HTTP 200 and that the most
 * important content from the spec is actually present in the
 * rendered HTML.
 */

test.describe("marketing pages", () => {
  test("home page shows the hero and CTA links", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", {
        name: /Real interview feedback\./,
        level: 1,
      }),
    ).toBeVisible();

    // Spec: primary CTA links to /signup
    const cta = page.getByRole("link", { name: /Get started/i }).first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/signup");

    // Spec: How-it-works has the three steps
    await expect(page.getByText(/Set up your interview/)).toBeVisible();
    await expect(page.getByText(/Record your voice/)).toBeVisible();
    await expect(page.getByText(/Get structured feedback/)).toBeVisible();
  });

  test("honest-interview-feedback page loads with correct content and metadata", async ({
    page,
  }) => {
    const response = await page.goto("/honest-interview-feedback");
    expect(response?.status()).toBe(200);

    await expect(
      page.getByRole("heading", {
        name: "Honest Interview Feedback — From the Interview You Actually Had",
        level: 1,
      }),
    ).toBeVisible();

    const cta = page
      .getByRole("link", { name: /Start your first analysis/i })
      .first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/signup");

    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      "Honest Interview Feedback — From the Interview You Actually Had",
    );
  });

  test("honest-interview-feedback page renders correctly at mobile viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/honest-interview-feedback");

    await expect(
      page.getByRole("heading", {
        name: "Honest Interview Feedback — From the Interview You Actually Had",
        level: 1,
      }),
    ).toBeVisible();

    const cta = page
      .getByRole("link", { name: /Start your first analysis/i })
      .first();
    await expect(cta).toBeVisible();

    const box = await cta.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("home page links to /honest-interview-feedback", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: /See examples/i }),
    ).toHaveAttribute("href", "/honest-interview-feedback");
  });

  test("footer links navigate to the right routes", async ({ page }) => {
    await page.goto("/");
    const footer = page.getByRole("contentinfo");
    await expect(footer).toBeVisible();

    for (const [label, href] of [
      ["Honest interview feedback", "/honest-interview-feedback"],
      ["Sample report", "/sample-report"],
    ] as const) {
      await expect(
        footer.getByRole("link", { name: label }),
      ).toHaveAttribute("href", href);
    }
  });
});
