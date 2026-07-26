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
        name: /Real interview feedback\. From your real interviews\./,
        level: 1,
      }),
    ).toBeVisible();

    // Spec: primary CTA links to /signup
    const cta = page.getByRole("link", { name: /Get your free analysis/i }).first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/signup");

    // Spec: pricing teaser links to /pricing
    await expect(
      page.getByRole("link", { name: /^See pricing$/i }).first(),
    ).toHaveAttribute("href", "/pricing");

    // Spec: How-it-works has the three steps
    await expect(page.getByText(/Set up your interview/)).toBeVisible();
    await expect(page.getByText(/Record your voice/)).toBeVisible();
    await expect(page.getByText(/Get structured feedback/)).toBeVisible();

    // Spec: FAQ contains the legality question
    await expect(page.getByText(/Is this legal\?/)).toBeVisible();
  });

  test("pricing page shows the three credit packs", async ({ page }) => {
    await page.goto("/pricing");

    await expect(
      page.getByRole("heading", { name: /Pay only for what you use/i }),
    ).toBeVisible();

    for (const pack of ["Starter", "Standard", "Heavy Prep"]) {
      await expect(
        page.getByRole("heading", { name: pack, exact: true }),
      ).toBeVisible();
    }

    // Credit usage table
    await expect(page.getByText(/Up to 30 minutes/)).toBeVisible();
    await expect(page.getByText(/Up to 120 minutes/)).toBeVisible();
  });

  test("about page mentions the privacy commitment", async ({ page }) => {
    await page.goto("/about");
    await expect(
      page.getByRole("heading", { name: /Why InterviewReplay exists/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/No surveillance, only reflection/i),
    ).toBeVisible();
  });

  test("privacy and terms each show the counsel-review banner", async ({
    page,
  }) => {
    for (const path of ["/privacy", "/terms"] as const) {
      await page.goto(path);
      await expect(
        page.getByText(/reviewed by counsel before public launch/i),
      ).toBeVisible();
    }
  });

  test("honest-interview-feedback page loads with correct content and metadata", async ({
    page,
  }) => {
    const response = await page.goto("/honest-interview-feedback");
    expect(response?.status()).toBe(200);

    // H1 — exact text per spec
    await expect(
      page.getByRole("heading", {
        name: "Honest Interview Feedback — From the Interview You Actually Had",
        level: 1,
      }),
    ).toBeVisible();

    // CTA button exists, is a real link, points to /signup
    const cta = page
      .getByRole("link", { name: /Start your first analysis/i })
      .first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/signup");

    // Open Graph metadata
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      "Honest Interview Feedback — From the Interview You Actually Had",
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      "https://example.com/honest-interview-feedback",
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      "https://example.com/og/ir-og-honest-feedback.png",
    );

    // Schema.org JSON-LD
    const jsonLd = page.locator('script[type="application/ld+json"]').first();
    await expect(jsonLd).toBeAttached();
    const rawJson = await jsonLd.textContent();
    expect(() => JSON.parse(rawJson ?? "")).not.toThrow();
    const schema = JSON.parse(rawJson ?? "{}");
    expect(schema["@type"]).toBe("Service");
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

    // Touch target — bounding box at least 44×44px
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
      ["About", "/about"],
      ["Pricing", "/pricing"],
      ["Honest interview feedback", "/honest-interview-feedback"],
      ["Privacy", "/privacy"],
      ["Terms", "/terms"],
    ] as const) {
      await expect(
        footer.getByRole("link", { name: label }),
      ).toHaveAttribute("href", href);
    }
  });
});
