import { expect, test, type Page } from "@playwright/test";

import {
  SEED_EMAIL,
  SEED_PASSWORD,
  sampleSessions,
} from "../../src/scripts/seed-fixtures";

/**
 * End-to-end test for the Interview Outcome feature.
 *
 * Drives the same sign-in flow as the dashboard spec, then walks
 * the full record → view → edit → delete cycle on a seeded
 * `complete` session. Acme Corp is the canonical fixture (1 day
 * old, complete) and we use it throughout.
 *
 * What this catches that the unit tests don't:
 *   - The page mounts the form and the API contract round-trips
 *     through real fetch (the unit tests call route handlers
 *     directly).
 *   - The outcome card on the report view re-renders after
 *     create / delete because of the `router.refresh()` call.
 *   - The dashboard badge picks up the recorded outcome on the
 *     listing query.
 */

const COMPLETE_SESSION = sampleSessions.find((s) => s.state === "complete");
if (!COMPLETE_SESSION) {
  throw new Error(
    "tests/e2e/sessions-outcome.spec.ts requires at least one seeded " +
      "complete session — see src/scripts/seed-fixtures.ts.",
  );
}

/**
 * Submit credentials and wait for the dashboard. Mirrors the
 * helper in dashboard.spec.ts so both files stay independent
 * (no shared imports across spec files keeps Playwright's
 * `fullyParallel: false` invariant explicit).
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
      `Sign-in did not land on /dashboard. Alert: ${message?.trim() ?? "<no text>"}`,
    );
  }
}

/**
 * Click the seeded company's session card and wait for the
 * /sessions/{id} URL. Returns the session id the dashboard
 * routed to so the rest of the test can reuse it.
 */
async function openSessionByCompany(
  page: Page,
  company: string,
): Promise<string> {
  await page
    .getByRole("link", { name: `Open session: ${company}`, exact: false })
    .click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 5_000 });
  const url = page.url();
  const id = /\/sessions\/([0-9a-f-]{36})/.exec(url)?.[1];
  if (!id) {
    throw new Error(`could not extract session id from URL: ${url}`);
  }
  return id;
}

async function ensureNoOutcomeViaApi(
  page: Page,
  sessionId: string,
): Promise<void> {
  // Best-effort cleanup so the spec is idempotent across re-runs.
  // The seed creates the session but not an outcome; if a previous
  // failed run left one behind, drop it.
  await page.request.delete(`/api/sessions/${sessionId}/outcome`).catch(() => {
    /* no outcome to delete — fine */
  });
}

test.describe("interview outcome flow", () => {
  test("record, edit, then delete an outcome end-to-end", async ({
    page,
  }) => {
    await signIn(page, SEED_EMAIL, SEED_PASSWORD);
    const sessionId = await openSessionByCompany(
      page,
      COMPLETE_SESSION!.companyName,
    );
    await ensureNoOutcomeViaApi(page, sessionId);
    await page.reload();

    /* ───────── 1. EMPTY STATE ───────── */
    // The outcome card shows the empty-state heading and the
    // "Record outcome" CTA.
    await expect(
      page.getByRole("heading", { name: /How did this interview go\?/i }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: /^Record outcome$/i })
      .click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}\/outcome$/, {
      timeout: 5_000,
    });

    /* ───────── 2. RECORD FORM ───────── */
    await expect(
      page.getByRole("heading", { name: /Outcome for/i, level: 1 }),
    ).toBeVisible();

    // Pick "Received an offer" via the radio group.
    await page.getByRole("radio", { name: /Received an offer/i }).check();

    // Fill the optional fields.
    await page
      .getByLabel(/Did the company share any feedback\?/i)
      .fill("Verbal: very strong on the system design portion.");
    await page
      .getByLabel(/Your reflection notes/i)
      .fill("I felt confident throughout. Pace was right.");
    await page
      .getByLabel(/If you could redo this interview/i)
      .fill("Push back earlier on the latency assumption.");

    await page.getByRole("button", { name: /^Save outcome$/i }).click();

    // Land back on the session report.
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });

    /* ───────── 3. RECORDED STATE ON REPORT ───────── */
    // The card now shows the offer headline.
    await expect(
      page.getByRole("heading", { name: /You received an offer/i }),
    ).toBeVisible();
    // And the would_change italic line.
    await expect(
      page.getByText(/Push back earlier on the latency assumption/i),
    ).toBeVisible();

    /* ───────── 4. EDIT THE OUTCOME ───────── */
    await page.getByRole("link", { name: /Edit outcome/i }).click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}\/outcome$/, {
      timeout: 5_000,
    });

    // Switch to "Advanced to next round" — the next-round input
    // should appear conditionally.
    await page
      .getByRole("radio", { name: /Advanced to next round/i })
      .check();
    await expect(
      page.getByLabel(/What's the next round\?/i),
    ).toBeVisible();
    await page
      .getByLabel(/What's the next round\?/i)
      .fill("Onsite loop");

    await page.getByRole("button", { name: /^Save outcome$/i }).click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 10_000 });

    await expect(
      page.getByRole("heading", { name: /Advanced to next round/i }),
    ).toBeVisible();
    await expect(page.getByText(/Next: Onsite loop/i)).toBeVisible();

    /* ───────── 5. DELETE THE OUTCOME ───────── */
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /Delete outcome/i }).click();

    // After delete, the empty state returns.
    await expect(
      page.getByRole("heading", { name: /How did this interview go\?/i }),
    ).toBeVisible({ timeout: 10_000 });

    /* ───────── 6. DASHBOARD BADGE (re-record then check) ───────── */
    // Record an outcome again to verify the dashboard badge.
    await page
      .getByRole("link", { name: /^Record outcome$/i })
      .click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}\/outcome$/);
    await page.getByRole("radio", { name: /Rejected/i }).check();
    await page.getByRole("button", { name: /^Save outcome$/i }).click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/);

    await page.goto("/dashboard");
    // The Acme card now shows the "Rejected" outcome badge.
    const acmeCard = page
      .getByRole("link", {
        name: `Open session: ${COMPLETE_SESSION!.companyName}`,
        exact: false,
      })
      .first();
    await expect(acmeCard).toContainText("Rejected");

    // Cleanup: drop the outcome we just made so the spec is
    // idempotent across local re-runs against the same DB.
    await page.request
      .delete(`/api/sessions/${sessionId}/outcome`)
      .catch(() => {
        /* best-effort */
      });
  });
});
