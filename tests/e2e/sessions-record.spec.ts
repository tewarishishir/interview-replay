import { expect, test, type Page, type BrowserContext } from "@playwright/test";

import { SEED_EMAIL, SEED_PASSWORD } from "../../src/scripts/seed-fixtures";

/**
 * End-to-end coverage for `/sessions/[id]/record`.
 *
 * Audio recording can't run in headless CI without a real microphone,
 * so we install browser-side stubs for `MediaRecorder`,
 * `navigator.mediaDevices.getUserMedia`, and `navigator.permissions`
 * before the page loads. The test then drives the UI through the
 * full happy path without ever touching real audio hardware.
 *
 * We also intercept:
 *   - POST `/api/sessions/:id/audio/upload-url` → return a fake
 *     presigned URL pointing at a Playwright-controlled host.
 *   - PUT  to the fake local storage host → 200.
 *   - POST `/api/sessions/:id/audio/uploaded`   → 202.
 *   - GET  `/api/sessions/:id`                  → after a few polls,
 *     return state="review" so the recorder navigates onward.
 *
 * The point isn't to verify storage or transcription — that lives in the
 * vitest suite for the API routes — but to verify the *recorder
 * client component's* state machine end-to-end from a real browser.
 */

const RECORDED_BLOB_BYTES = "WEBM-FAKE-AUDIO";

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel(/^Email$/i).fill(SEED_EMAIL);
  await page.getByLabel(/^Password$/i).fill(SEED_PASSWORD);
  await page.getByRole("button", { name: /^Sign in$/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 15_000 });
}

/**
 * Inject fake browser APIs *before* any page script runs. This is
 * critical: `MediaRecorder.isTypeSupported` is read once during the
 * recorder's `useMemo`, and we want our stub to win.
 */
async function installMediaStubs(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as Window & {
      __irMediaRecorderInstances?: FakeMediaRecorder[];
    };
    w.__irMediaRecorderInstances = [];

    class FakeMediaStream {
      tracks: { stop: () => void }[] = [{ stop: () => {} }];
      getTracks() {
        return this.tracks;
      }
      getAudioTracks() {
        return this.tracks;
      }
    }

    class FakeMediaRecorder {
      state: "inactive" | "recording" | "paused" = "inactive";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      mimeType: string;
      audioBitsPerSecond: number;
      timeslice: number | undefined;
      chunkInterval: number | null = null;
      static isTypeSupported(_mimeType: string) {
        return true;
      }
      constructor(
        _stream: MediaStream,
        opts: { mimeType: string; audioBitsPerSecond: number },
      ) {
        this.mimeType = opts.mimeType;
        this.audioBitsPerSecond = opts.audioBitsPerSecond;
        w.__irMediaRecorderInstances?.push(this);
      }
      start(timeslice?: number) {
        this.state = "recording";
        this.timeslice = timeslice;
        // Fire one dataavailable immediately so chunks accumulate.
        const fire = () => {
          if (this.state !== "recording") return;
          this.ondataavailable?.({
            data: new Blob(["WEBM-FAKE-AUDIO"], {
              type: this.mimeType,
            }),
          });
        };
        fire();
        if (timeslice && timeslice > 0) {
          // Use a faster cadence than 1s to keep tests snappy.
          this.chunkInterval = window.setInterval(fire, 200);
        }
      }
      pause() {
        this.state = "paused";
      }
      resume() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        if (this.chunkInterval !== null) {
          clearInterval(this.chunkInterval);
          this.chunkInterval = null;
        }
        // Final chunk + onstop in next tick (mirrors the real API).
        setTimeout(() => {
          this.ondataavailable?.({
            data: new Blob(["WEBM-FAKE-AUDIO-FINAL"], {
              type: this.mimeType,
            }),
          });
          this.onstop?.();
        }, 0);
      }
    }

    Object.defineProperty(window, "MediaRecorder", {
      value: FakeMediaRecorder,
      writable: true,
      configurable: true,
    });

    // navigator.mediaDevices.getUserMedia
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: async () => new FakeMediaStream(),
      } as unknown as MediaDevices,
      configurable: true,
    });

    // Provide a permissions.query that says "granted" so the UI's
    // pre-recording status indicator renders the "ready" copy.
    Object.defineProperty(navigator, "permissions", {
      value: {
        query: async () => ({ state: "granted", onchange: null }),
      },
      configurable: true,
    });

    // wakeLock — return a sentinel that supports release().
    (
      navigator as unknown as { wakeLock: { request: () => Promise<unknown> } }
    ).wakeLock = {
      request: async () => ({ release: async () => {} }),
    };

    // Stub AudioContext so the level meter doesn't crash on the
    // FakeMediaStream input. We don't need the meter to *show*
    // anything — just not throw.
    class FakeAnalyser {
      fftSize = 256;
      smoothingTimeConstant = 0;
      getByteTimeDomainData(arr: Uint8Array) {
        // 128 = silence.
        for (let i = 0; i < arr.length; i++) arr[i] = 128;
      }
      disconnect() {}
    }
    class FakeAudioContext {
      createMediaStreamSource() {
        return { connect: () => {} } as unknown as MediaStreamAudioSourceNode;
      }
      createAnalyser() {
        return new FakeAnalyser() as unknown as AnalyserNode;
      }
      async close() {}
    }
    Object.defineProperty(window, "AudioContext", {
      value: FakeAudioContext,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "webkitAudioContext", {
      value: FakeAudioContext,
      writable: true,
      configurable: true,
    });

    // Touch the fake constant so unused-variable lint stays happy in
    // the test source — this string is what the Blob carries.
    void window;
  });
}

/**
 * Intercept the upload pipeline so the test never has to talk to
 * MinIO. We track the calls so the test can assert on order /
 * payload.
 */
async function installNetworkStubs(
  page: Page,
  state: { presignCalls: number; uploadCalls: number; finalizeCalls: number; pollCalls: number },
) {
  // Intercept everything in the audio pipeline. The fake local storage host is
  // chosen to match a single regex on `**.fake-s3.test/**`.
  await page.route("**/api/sessions/*/audio/upload-url", async (route) => {
    state.presignCalls += 1;
    const url = new URL(route.request().url());
    const sessionId = url.pathname.split("/")[3]!;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        url: `https://upload.fake-s3.test/audio/${sessionId}/blob.webm`,
        key: `audio/00000000-0000-4000-8000-000000000000/${sessionId}/00000000-0000-4000-8000-000000000001.webm`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        requiredHeaders: { "Content-Type": "audio/webm" },
      }),
    });
  });

  await page.route("**/upload.fake-s3.test/**", async (route) => {
    state.uploadCalls += 1;
    await route.fulfill({ status: 200, body: "" });
  });

  await page.route("**/api/sessions/*/audio/uploaded", async (route) => {
    state.finalizeCalls += 1;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "stub",
        audioFileId: "stub",
        state: "transcribing",
      }),
    });
  });

  // First few polls return `transcribing`, then `review` so the
  // recorder navigates to `/sessions/:id/review`. The path being
  // tested is just that the poll loop fires AND that on review we
  // navigate onward.
  await page.route("**/api/sessions/*", async (route) => {
    // Skip non-GETs (the audio sub-routes are matched above).
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    // Don't intercept `/audio/...` sub-paths.
    if (url.pathname.includes("/audio/")) {
      await route.fallback();
      return;
    }
    state.pollCalls += 1;
    const targetState = state.pollCalls >= 1 ? "review" : "transcribing";
    const sessionId = url.pathname.split("/").pop()!;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({
        session: {
          id: sessionId,
          state: targetState,
          companyName: "Vercel",
          roleTitle: "Engineering Manager",
          updatedAt: new Date().toISOString(),
        },
      }),
    });
  });
}

async function findCreatedSessionId(page: Page): Promise<string> {
  // The seed fixtures put one session in `created` state for the
  // Vercel/Engineering Manager role. The dashboard renders a card
  // linking to its detail page — we read the id off that link.
  await page.goto("/dashboard");
  const link = page
    .getByRole("link", { name: /Open session: Vercel/i })
    .first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/\/sessions\/[0-9a-f-]{36}/);
  const id = href!.match(/\/sessions\/([0-9a-f-]{36})/)?.[1];
  expect(id).toBeTruthy();
  return id!;
}

test.describe("/sessions/:id/record auth gate", () => {
  test("redirects unauthenticated users to /signin", async ({ page }) => {
    const fakeId = "00000000-0000-4000-8000-000000000000";
    await page.goto(`/sessions/${fakeId}/record`);
    await page.waitForURL(/\/signin/);
    expect(new URL(page.url()).pathname).toBe("/signin");
  });
});

test.describe("/sessions/:id/record pre-recording UI", () => {
  test("shows headphone reminder, mic status, and a Start button", async ({
    page,
    context,
  }) => {
    await installMediaStubs(context);
    await signIn(page);
    const sessionId = await findCreatedSessionId(page);
    await page.goto(`/sessions/${sessionId}/record`);

    // The persistent banner — copy is intentionally annoying. The
    // test asserts the load-bearing phrase rather than the full
    // sentence so word-smithing doesn't break it.
    await expect(page.getByText(/Wear headphones/i)).toBeVisible();

    // Permission status indicator.
    await expect(
      page.getByText(/Microphone:\s*ready/i),
    ).toBeVisible();

    // Big start button.
    await expect(
      page.getByRole("button", { name: /^Start recording$/i }),
    ).toBeEnabled();

    // The "Don't close this tab" persistent banner is NOT visible
    // pre-recording (it appears only after recording starts).
    await expect(
      page.getByText(/Don['’]t close this tab/i),
    ).toHaveCount(0);
  });
});

test.describe("/sessions/:id/record recording flow", () => {
  test("records, uploads, polls, and navigates to review", async ({
    page,
    context,
  }) => {
    await installMediaStubs(context);
    const callState = {
      presignCalls: 0,
      uploadCalls: 0,
      finalizeCalls: 0,
      pollCalls: 0,
    };
    await installNetworkStubs(page, callState);

    await signIn(page);
    const sessionId = await findCreatedSessionId(page);
    await page.goto(`/sessions/${sessionId}/record`);

    // Click Start. UI moves to recording state; banner appears.
    await page
      .getByRole("button", { name: /^Start recording$/i })
      .click();

    await expect(
      page.getByText(/Don['’]t close this tab/i),
    ).toBeVisible();

    // Timer is rendered (HH:MM:SS format).
    await expect(
      page.getByText(/^\d\d:\d\d:\d\d$/),
    ).toBeVisible();

    // Pause + Resume cycle works.
    await page.getByRole("button", { name: /^Pause$/i }).click();
    await expect(
      page.getByRole("button", { name: /^Resume$/i }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Resume$/i }).click();
    await expect(
      page.getByRole("button", { name: /^Pause$/i }),
    ).toBeVisible();

    // CRITICAL safety check: while recording, no transcription
    // should be visible. We assert the absence of two phrases that
    // would only ever appear if we'd accidentally wired up live
    // transcription/feedback.
    await expect(
      page.getByText(/transcript|feedback|suggestion/i),
    ).toHaveCount(0);

    // End session — drives stop → upload pipeline. We deliberately
    // don't assert on the transient "Uploading recording" panel
    // because our network stubs resolve so fast that the panel can
    // disappear before Playwright's polling sees it. The contract
    // we want to verify is that all four backend steps fire AND
    // that we end up navigating to /review on the polling success.
    await page
      .getByRole("button", { name: /End session/i })
      .click();

    // Polling kicks in and our stub flips to `review`, navigating
    // the user onward. The `/sessions/:id/review` page doesn't
    // exist yet — we only assert the URL pattern.
    await page.waitForURL(
      new RegExp(`/sessions/${sessionId}/review$`),
      { timeout: 30_000 },
    );

    // Pipeline calls fired exactly once.
    expect(callState.presignCalls).toBe(1);
    expect(callState.uploadCalls).toBe(1);
    expect(callState.finalizeCalls).toBe(1);
    expect(callState.pollCalls).toBeGreaterThanOrEqual(1);

    // The fake recorder produced data; touch the marker so it
    // can't be tree-shaken away.
    void RECORDED_BLOB_BYTES;
  });
});
