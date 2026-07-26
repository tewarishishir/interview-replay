import { expect, test, type Page } from "@playwright/test";

import {
  SEED_EMAIL,
  SEED_PASSWORD,
  sampleSessions,
} from "../../src/scripts/seed-fixtures";

/**
 * End-to-end test for the Practice Rebuild feature.
 *
 * Drives:
 *   1. Sign in → dashboard.
 *   2. Open the seeded `complete` session report.
 *   3. Click an inline "Rebuild a story for this" button on an
 *      Improvement.
 *   4. Walk through the 6-step flow:
 *        Step 2: enter a headline.
 *        Step 3: pick "Start with empty fields" so the spec's
 *                 verbatim-pull contract is exercised by Step 4.
 *        Step 4: fill Situation / Task / Action / Result.
 *        Step 5: click Get critique. We INTERCEPT the critique
 *                 API call with a deterministic response that
 *                 includes a `profile_consistency` discrepancy
 *                 AND a `profile_leverage` suggestion so the
 *                 critique UI's special layouts both render.
 *                 Then pick a theme via the theme picker and
 *                 Save to story bank, verify the saved view.
 *   5. Open /stories and confirm the new story appears in the
 *      bank (the spec's acceptance criterion).
 *
 * What this catches that the unit tests don't:
 *   - The route-based 6-step flow's `initialStepFor` resume logic
 *     when the user lands on /rebuilds/[id].
 *   - The critique view's special layouts: the side-by-side
 *     `discrepancy` comparison AND the `profile_leverage`
 *     verbatim-quote block.
 *   - The save-to-bank wire — POST `/api/rebuilds/:id/save-to-bank`
 *     followed by `router.push` for the saved confirmation.
 *
 * Why we mock the critique response:
 *   The route's underlying call hits LLM provider. We don't want CI
 *   making real LLM calls (cost + flake). The mock pins a critique
 *   shape that exercises every UI affordance we care about.
 */

const COMPLETE_SESSION = sampleSessions.find((s) => s.state === "complete");
if (!COMPLETE_SESSION) {
  throw new Error(
    "tests/e2e/rebuilds.spec.ts requires at least one seeded `complete` session.",
  );
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel(/^Email$/i).fill(SEED_EMAIL);
  await page.getByLabel(/^Password$/i).fill(SEED_PASSWORD);
  await page.getByRole("button", { name: /^Sign in$/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 15_000 });
}

async function openSessionByCompany(page: Page, company: string): Promise<string> {
  await page
    .getByRole("link", { name: `Open session: ${company}`, exact: false })
    .click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 5_000 });
  const id = /\/sessions\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (!id) throw new Error(`failed to extract session id from URL: ${page.url()}`);
  return id;
}

/**
 * Mock critique response. The shape MUST validate against
 * `critiqueResponseSchema`. We exercise the two profile-grounded
 * dimensions because they have special layouts in the critique
 * view; the other five are filled with generic `needs_work`
 * feedback so the dimension list renders the full set.
 */
const MOCK_CRITIQUE = {
  overall_assessment:
    "Solid scaffolding. The action is well-structured but the result needs a number.",
  dimension_feedback: [
    {
      dimension: "headline",
      status: "strong",
      quoted_excerpt: "Drove the migration.",
      what_to_check: "This is well-structured.",
    },
    {
      dimension: "star_completeness",
      status: "needs_work",
      quoted_excerpt: "",
      what_to_check: "Verify each STAR section reads as a distinct beat.",
    },
    {
      dimension: "first_person",
      status: "strong",
      quoted_excerpt: "I led",
      what_to_check: "This is well-structured.",
    },
    {
      dimension: "quantification",
      status: "missing",
      quoted_excerpt: "",
      what_to_check: "Add a measurable result — pick one number.",
    },
    {
      dimension: "profile_consistency",
      status: "discrepancy",
      quoted_excerpt: "team of 8",
      profile_reference: {
        field_path: "user_projects[id=p-1].team_size",
        field_value: "team of 4",
      },
      what_to_check:
        "Verify whether you led the same team across both periods.",
    },
    {
      dimension: "profile_leverage",
      status: "needs_work",
      quoted_excerpt: "we made it faster",
      profile_reference: {
        field_path: "user_projects[id=p-1].outcomes_with_metrics",
        field_value: "cut deploy time from 40 to 12 minutes",
      },
      what_to_check:
        "If you owned that outcome, consider whether to mention it.",
    },
  ],
  next_step_suggestion:
    "Replace 'we made it faster' with the specific minute count from your project notes.",
};

async function mockCritiqueResponse(page: Page, rebuildId?: string) {
  // Match either a specific rebuild id (when known) or any rebuild id
  // — Playwright's URL pattern doesn't have to be exact.
  const pattern = rebuildId
    ? `**/api/rebuilds/${rebuildId}/critique`
    : "**/api/rebuilds/*/critique";
  await page.route(pattern, async (route) => {
    // Hit the real PATCH'd rebuild via the API to grab the id +
    // shape. Cheaper: just construct the JSON body with the same
    // wire shape the server returns.
    const url = route.request().url();
    const id = /\/api\/rebuilds\/([0-9a-f-]{36})/.exec(url)?.[1] ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rebuild: {
          id,
          aiCritique: MOCK_CRITIQUE,
          status: "critiqued",
          critiqueRunCount: 1,
          critiqueRunsLast24h: 1,
          // Other fields the UI doesn't render off — null/empty
          // is fine because TypeScript erases the DTO type at the
          // wire boundary.
          headline: "Drove the migration.",
          situation: "We had a 90-day mandate.",
          task: "I was the tech lead.",
          action: "Split the work into two phases.",
          result: "We made it faster.",
          whatIWouldChange: null,
          questionText: "Tell me about a tough call",
          questionTheme: "leadership_conflict",
          sourceSessionId: null,
          sourceImprovementIndex: null,
          promotedToStoryId: null,
          userId: "11111111-1111-1111-1111-111111111111",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          aiSuggestedResponse: null,
          aiSuggestedResponseGeneratedAt: null,
          suggestionRunsLast24h: 0,
        },
        passedGuardrails: true,
        guardrailTripCount: 0,
      }),
    });
  });
}

/**
 * Mock the suggested-response API. The shape MUST validate
 * against `suggestedResponseSchema`. We emit a minimal grounded
 * draft so the UI's STAR sections + sources footnote both render.
 */
const MOCK_SUGGESTION = {
  headline: "I cut deploy errors by 50% by phasing the migration.",
  situation:
    "Our checkout pipeline had a 12% deploy failure rate before the rewrite.",
  task: "I owned the migration plan as the new tech lead.",
  action:
    "I split the rollout into a two-phase flag-gated cut-over with daily syncs across teams.",
  result: "Deploy errors fell from 12% to 6% in the first six weeks.",
  whatIWouldChange: null,
  sources: [
    {
      field_path: "projects[id=p-1].outcomes_with_metrics",
      field_value: "cut deploy time from 40 to 12 minutes",
    },
  ],
  caveats: [],
};

async function mockSuggestResponse(page: Page) {
  await page.route("**/api/rebuilds/*/suggest-response", async (route) => {
    const url = route.request().url();
    const id = /\/api\/rebuilds\/([0-9a-f-]{36})/.exec(url)?.[1] ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rebuild: {
          id,
          aiCritique: null,
          status: "in_progress",
          critiqueRunCount: 0,
          critiqueRunsLast24h: 0,
          headline: "Drove the migration.",
          situation: "We had a 90-day mandate.",
          task: "I was the tech lead.",
          action: "Split the work into two phases.",
          result: "We made it faster.",
          whatIWouldChange: null,
          questionText: "Tell me about a tough call",
          questionTheme: "leadership_conflict",
          sourceSessionId: null,
          sourceImprovementIndex: null,
          promotedToStoryId: null,
          userId: "11111111-1111-1111-1111-111111111111",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          aiSuggestedResponse: MOCK_SUGGESTION,
          aiSuggestedResponseGeneratedAt: new Date().toISOString(),
          suggestionRunsLast24h: 1,
        },
        syntheticSuggestion: null,
        passedGuardrails: true,
        creditsCharged: 0,
        balanceAfter: 9,
      }),
    });
  });
}

test.describe("Practice Rebuild — full flow", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Chromium only");

  test("rebuild from a report → critique view shows both special layouts → save to bank", async ({
    page,
  }) => {
    await signIn(page);
    const sessionId = await openSessionByCompany(page, COMPLETE_SESSION.companyName);
    void sessionId;

    // Inline launcher under one of the Improvements. The seeded
    // report has improvements; we just click the first launcher.
    const inlineButton = page
      .getByRole("button", { name: /^Rebuild a story for this/i })
      .first();
    await expect(inlineButton).toBeVisible({ timeout: 10_000 });

    await mockCritiqueResponse(page);
    await inlineButton.click();
    await page.waitForURL(/\/rebuilds\/[0-9a-f-]{36}$/, { timeout: 5_000 });

    // Step 2 — headline.
    await page
      .getByLabel(/^Headline$/i)
      .fill("I rewired our deploy pipeline to cut error rates in half.");
    await page.getByRole("button", { name: /^Continue$/i }).click();

    // Step 3 — Start fresh so the next step's textareas are empty
    // (the verbatim-pull path is exercised in a separate spec).
    await page.getByRole("button", { name: /^Start with empty fields$/i }).click();

    // Step 4 — STAR scaffold.
    await page.getByLabel(/^Situation$/).fill("We had a 90-day mandate from the CFO to cut payment errors.");
    await page.getByLabel(/^Task$/).fill("I was the tech lead on the migration team of 8 engineers.");
    await page.getByLabel(/^Action$/).fill("I split the work into two phases and ran daily syncs with the dependent teams.");
    await page.getByLabel(/^Result$/).fill("We made it faster — we shipped 18 days early.");

    // The reversed-stance banner is load-bearing copy: the spec was
    // updated to allow AI generation, and the banner now mentions
    // "an AI draft for you to compare against" alongside the
    // critique mission.
    await expect(
      page.getByText(/InterviewReplay will critique your draft\. We can also generate an AI draft/i),
    ).toBeVisible();

    await page.getByRole("button", { name: /^Get critique$/i }).click();

    // Step 5 — critique view. Assert the two special layouts:
    //   - profile_consistency discrepancy renders side-by-side
    //     "In your draft you wrote / In your profile under …"
    //   - profile_leverage renders the verbatim profile snippet
    await expect(page.getByText(/Overall assessment/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("In your draft you wrote:")).toBeVisible();
    await expect(page.getByText("In your profile under")).toBeVisible();
    await expect(
      page.getByText("Your profile has stronger evidence for this:"),
    ).toBeVisible();
    await expect(page.getByText(MOCK_CRITIQUE.next_step_suggestion)).toBeVisible();

    // Theme picker — pick "Leadership conflict" so the saved
    // story doesn't fall back to "Other". The default is
    // pre-filled with whatever the rebuild already carries; we
    // still click through to exercise the picker wire.
    await page.getByLabel(/^File this story under$/i).click();
    await page
      .getByRole("option", { name: /^Leadership conflict$/i })
      .click();

    // Save to bank. The save-to-bank route IS hit for real (no
    // mock) so the spec also covers the API contract on the way
    // out. The seed user has no other stories blocking the cap.
    await page.getByRole("button", { name: /^Save to story bank$/i }).click();
    await expect(
      page.getByRole("heading", { name: /^Saved to your story bank$/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Spec acceptance: saved rebuilds appear in the top-level
    // Story Bank page (extracted from the old in-profile section).
    await page.getByRole("link", { name: /^View story bank/i }).click();
    await page.waitForURL(/\/stories/);
    await expect(
      page.getByText("I rewired our deploy pipeline to cut error rates in half."),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("revise and re-critique returns to scaffold with text intact", async ({
    page,
  }) => {
    await signIn(page);
    await openSessionByCompany(page, COMPLETE_SESSION.companyName);

    await mockCritiqueResponse(page);

    await page
      .getByRole("button", { name: /^Rebuild a story for this/i })
      .first()
      .click();
    await page.waitForURL(/\/rebuilds\/[0-9a-f-]{36}$/);

    await page.getByLabel(/^Headline$/i).fill("Driving the migration");
    await page.getByRole("button", { name: /^Continue$/i }).click();
    await page.getByRole("button", { name: /^Start with empty fields$/i }).click();

    await page.getByLabel(/^Situation$/).fill("Setup line.");
    await page.getByLabel(/^Action$/).fill("I led.");
    await page.getByLabel(/^Result$/).fill("It worked.");

    await page.getByRole("button", { name: /^Get critique$/i }).click();
    await expect(page.getByText(/Overall assessment/i)).toBeVisible();

    await page.getByRole("button", { name: /^Revise$/i }).click();

    // Back at Step 4 — the field values must still be there.
    await expect(page.getByLabel(/^Situation$/)).toHaveValue("Setup line.");
    await expect(page.getByLabel(/^Action$/)).toHaveValue("I led.");
    await expect(page.getByLabel(/^Result$/)).toHaveValue("It worked.");

    // Re-critique works (the rate gate allows up to 10/24h).
    await page.getByRole("button", { name: /^Get critique$/i }).click();
    await expect(page.getByText(/Overall assessment/i)).toBeVisible();
  });

  test("generate AI suggested response, regenerate, view it on the bank", async ({
    page,
  }) => {
    await signIn(page);
    await openSessionByCompany(page, COMPLETE_SESSION.companyName);

    await mockCritiqueResponse(page);
    await mockSuggestResponse(page);

    await page
      .getByRole("button", { name: /^Rebuild a story for this/i })
      .first()
      .click();
    await page.waitForURL(/\/rebuilds\/[0-9a-f-]{36}$/);

    // Walk to Step 4 fast — the AI-draft panel is here.
    await page.getByLabel(/^Headline$/i).fill("Driving the migration");
    await page.getByRole("button", { name: /^Continue$/i }).click();
    await page.getByRole("button", { name: /^Start with empty fields$/i }).click();

    // Generate the AI draft. The mocked response renders the
    // SuggestedResponseView with the persistent caveat banner.
    await page.getByRole("button", { name: /^Generate AI draft$/i }).click();

    // The persistent caveat is load-bearing — never optional, even
    // when guardrails pass.
    await expect(
      page.getByText(/This is a starting point — edit and make it yours/i),
    ).toBeVisible({ timeout: 10_000 });

    // The mock suggestion's headline appears.
    await expect(
      page.getByText(/I cut deploy errors by 50%/i),
    ).toBeVisible();

    // Sources block names the field path the model claimed to draw
    // on — anchors the verbatim guardrail story.
    await expect(page.getByText(/Drawn from your profile/i)).toBeVisible();

    // Regenerate. The button label flips once a draft exists.
    await page.getByRole("button", { name: /^Regenerate$/i }).click();
    await expect(
      page.getByText(/I cut deploy errors by 50%/i),
    ).toBeVisible();

    // Now critique + save to bank, then assert the bank card shows
    // the suggested-response affordance.
    await page.getByLabel(/^Situation$/).fill("Setup line.");
    await page.getByLabel(/^Action$/).fill("I led the rewrite.");
    await page.getByLabel(/^Result$/).fill("It worked.");

    await page.getByRole("button", { name: /^Get critique$/i }).click();
    await expect(page.getByText(/Overall assessment/i)).toBeVisible({
      timeout: 10_000,
    });

    await page.getByLabel(/^File this story under$/i).click();
    await page
      .getByRole("option", { name: /^Leadership conflict$/i })
      .click();
    await page.getByRole("button", { name: /^Save to story bank$/i }).click();
    await expect(
      page.getByRole("heading", { name: /^Saved to your story bank$/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Bank card surfaces the cached suggestion.
    await page.getByRole("link", { name: /^View story bank/i }).click();
    await page.waitForURL(/\/stories/);
    await expect(
      page.getByRole("button", {
        name: /^View AI suggested response$/i,
      }).first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});
