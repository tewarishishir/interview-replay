/**
 * Integration tests for `POST /api/feedback`.
 *
 * Mocks the auth + rate-limit + analytics boundaries; hits the
 * real Postgres for persistence assertions (the DB CHECK
 * constraints and the cascade behaviour are only meaningful
 * end-to-end).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";

import type * as RateLimitModule from "@/lib/rate-limit";

const DEFAULT_HEADERS = {
  origin: "http://localhost:3000",
  "x-forwarded-for": "203.0.113.42",
  "user-agent": "vitest",
};
let headerOverride: Record<string, string> | null = null;
const setHeaders = (h: Record<string, string> | null) => {
  headerOverride = h;
};
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerOverride ?? DEFAULT_HEADERS),
}));

const mockGetActiveUserId = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getActiveUserId: () => mockGetActiveUserId(),
}));

// The default limiter mock is "always open" so the happy-path
// tests aren't affected. The 429 test overrides it inline.
const limiterCheck = vi.fn(async () => ({
  success: true,
  limit: 5,
  remaining: 4,
  reset: Date.now() + 60_000,
}));
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>(
    "@/lib/rate-limit",
  );
  return {
    ...actual,
    feedbackWriteLimiter: () => ({ check: limiterCheck }),
  };
});

const trackServerEventMock = vi.fn();
vi.mock("@/lib/analytics/server", () => ({
  trackServerEvent: (...args: unknown[]) => trackServerEventMock(...args),
  identifyServerUser: () => undefined,
  flushAnalytics: async () => undefined,
}));

import type * as EmailTemplatesModule from "@/lib/email/templates";

const sendInternalNotificationMock = vi.fn(async () => ({ dispatched: false }));
const sendAcknowledgmentMock = vi.fn(async () => ({ dispatched: false }));
vi.mock("@/lib/email/templates", async () => {
  // Import and re-export everything else from the real module so
  // templates we don't care about here still work.
  const actual = await vi.importActual<typeof EmailTemplatesModule>(
    "@/lib/email/templates",
  );
  return {
    ...actual,
    sendInternalFeedbackNotificationEmail: (...args: unknown[]) =>
      (sendInternalNotificationMock as (...a: unknown[]) => Promise<{ dispatched: boolean }>)(...args),
    sendFeedbackAcknowledgmentEmail: (...args: unknown[]) =>
      (sendAcknowledgmentMock as (...a: unknown[]) => Promise<{ dispatched: boolean }>)(...args),
  };
});

import { POST } from "@/app/api/feedback/route";
import { createCredentialsUser } from "@/lib/auth/users";
import { db, schema } from "@/lib/db";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  mockGetActiveUserId.mockReset();
  limiterCheck.mockReset();
  limiterCheck.mockResolvedValue({
    success: true,
    limit: 5,
    remaining: 4,
    reset: Date.now() + 60_000,
  });
  trackServerEventMock.mockReset();
  sendInternalNotificationMock.mockReset();
  sendInternalNotificationMock.mockResolvedValue({ dispatched: false });
  sendAcknowledgmentMock.mockReset();
  sendAcknowledgmentMock.mockResolvedValue({ dispatched: false });
  setHeaders(null);
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

const seedUser = async (email = "alice@example.com") => {
  const r = await createCredentialsUser({
    email,
    password: "password123",
    name: "Alice",
  });
  if (!r.ok) throw new Error(`seedUser failed: ${r.error}`);
  return r.user;
};

const jsonRequest = (body: unknown): Request =>
  new Request("http://localhost:3000/api/feedback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify(body),
  });

describe("POST /api/feedback", () => {
  it("401s when there is no signed-in user", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await POST(
      jsonRequest({ rating: 5, message: "hi", consentPublic: false }),
    );
    expect(res.status).toBe(401);
  });

  it("403s on a cross-origin request", async () => {
    mockGetActiveUserId.mockResolvedValue("not-checked");
    setHeaders({
      origin: "https://evil.example.com",
      "user-agent": "vitest",
    });
    const req = new Request("http://localhost:3000/api/feedback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example.com",
      },
      body: JSON.stringify({
        rating: 5,
        message: "hi",
        consentPublic: false,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("400s on an out-of-range rating with a fieldErrors map", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await POST(
      jsonRequest({ rating: 7, message: "still good?", consentPublic: false }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fieldErrors: Record<string, string>;
    };
    expect(body.error).toBe("validation_failed");
    expect(body.fieldErrors.rating).toBeDefined();
  });

  it("400s when the message is empty", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await POST(
      jsonRequest({ rating: 4, message: "   ", consentPublic: false }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      fieldErrors: Record<string, string>;
    };
    expect(body.fieldErrors.message).toBeDefined();
  });

  it("429s when the rate limiter rejects", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    limiterCheck.mockResolvedValue({
      success: false,
      limit: 5,
      remaining: 0,
      reset: Date.now() + 60_000,
    });

    const res = await POST(
      jsonRequest({ rating: 5, message: "spam", consentPublic: false }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeDefined();
  });

  it("201s on the happy path, persists a pending row, and fires the analytics event", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await POST(
      jsonRequest({
        rating: 5,
        message: "Best interview prep tool I've used in years.",
        consentPublic: true,
        displayName: "Priya R.",
        displayRole: "Senior PM",
        pagePath: "/dashboard",
      }),
    );

    expect(res.status).toBe(201);

    // Persisted row matches what was submitted, status pending.
    const rows = await db
      .select()
      .from(schema.feedback)
      .where(eq(schema.feedback.userId, user.id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe("pending");
    expect(row.rating).toBe(5);
    expect(row.consentPublic).toBe(true);
    expect(row.displayName).toBe("Priya R.");
    expect(row.displayRole).toBe("Senior PM");
    expect(row.pagePath).toBe("/dashboard");

    // Analytics: metadata only — message LENGTH but NEVER body.
    // Filter for the feedback event specifically; the user
    // creation path may emit its own signup events before this
    // call, which is fine — we just care that ours landed.
    const feedbackCalls = trackServerEventMock.mock.calls.filter(
      (c) =>
        (c[0] as { event?: string }).event === "feedback_submitted",
    );
    expect(feedbackCalls).toHaveLength(1);
    const call = feedbackCalls[0]![0] as {
      distinctId: string;
      event: string;
      properties: Record<string, unknown>;
    };
    expect(call.distinctId).toBe(user.id);
    expect(call.event).toBe("feedback_submitted");
    expect(call.properties.rating).toBe(5);
    expect(call.properties.message_length).toBe(
      "Best interview prep tool I've used in years.".length,
    );
    expect(call.properties.has_consent).toBe(true);
    expect(call.properties.has_display_name).toBe(true);
    expect(call.properties.page_path).toBe("/dashboard");
    // Critical: the message body MUST NOT be in the analytics
    // payload. (Same posture as outcome events.)
    expect(JSON.stringify(call.properties)).not.toContain(
      "Best interview prep tool",
    );
  });

  it("fires both the internal notification and acknowledgment emails on the happy path", async () => {
    const user = await seedUser("bob@example.com");
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await POST(
      jsonRequest({
        rating: 4,
        message: "Really helpful breakdown of my technical round.",
        consentPublic: false,
        pagePath: "/sessions/abc123",
      }),
    );
    expect(res.status).toBe(201);

    // Give the void'd Promise.all a tick to resolve (it's synchronous
    // in tests because the mocks return immediately).
    await new Promise((r) => setTimeout(r, 0));

    // Internal notification → feedback@example.com
    expect(sendInternalNotificationMock).toHaveBeenCalledOnce();
    const notifArgs = (sendInternalNotificationMock.mock.calls as unknown[][])[0]![0] as {
      userEmail: string;
      userName: string | null;
      rating: number;
      pagePath: string | null;
    };
    expect(notifArgs.userEmail).toBe("bob@example.com");
    expect(notifArgs.rating).toBe(4);
    expect(notifArgs.pagePath).toBe("/sessions/abc123");

    // Acknowledgment → the user
    expect(sendAcknowledgmentMock).toHaveBeenCalledOnce();
    const ackArgs = (sendAcknowledgmentMock.mock.calls as unknown[][])[0]![0] as {
      to: string;
    };
    expect(ackArgs.to).toBe("bob@example.com");
  });
});
