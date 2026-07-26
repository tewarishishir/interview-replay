/**
 * Unit tests for `sendEmail` in `src/lib/email/client.ts`.
 *
 * These tests verify the category → reply-to mapping without
 * a real Resend connection. We mock the Resend SDK and env vars
 * so we can inspect what arguments would have been sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Resend mock ───────────────────────────────────────────────────────────────
// Must be set up before any import that lazy-initialises the client.
const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: resendSendMock },
  })),
}));

// ── Env mock ──────────────────────────────────────────────────────────────────
// Override the env module to make features.email=true and supply all addresses.
vi.mock("@/lib/env", () => ({
  env: {
    RESEND_API_KEY: "re_test_key",
    EMAIL_FROM_NAME: "InterviewReplay",
    EMAIL_FROM_ADDRESS: "noreply@example.com",
    EMAIL_REPLY_TO_GENERAL: "hello@example.com",
    EMAIL_REPLY_TO_PRIVACY: "privacy@example.com",
    EMAIL_REPLY_TO_FEEDBACK: "feedback@example.com",
    EMAIL_REPLY_TO_FOUNDERS: "founders@example.com",
  },
  features: { email: true },
  isProduction: false,
}));

import { sendEmail } from "@/lib/email/client";

const MINIMAL_ARGS = {
  to: "user@example.com",
  subject: "Test email",
  html: "<p>Hello</p>",
} as const;

beforeEach(() => {
  resendSendMock.mockReset();
  resendSendMock.mockResolvedValue({ data: { id: "msg_test_123" }, error: null });
});

describe("sendEmail — category → reply-to mapping", () => {
  it("uses hello@example.com as reply-to for category='general'", async () => {
    const result = await sendEmail({ ...MINIMAL_ARGS, category: "general" });

    expect(result.dispatched).toBe(true);
    expect(resendSendMock).toHaveBeenCalledOnce();
    const args = resendSendMock.mock.calls[0]![0] as {
      replyTo: string;
      from: string;
    };
    expect(args.replyTo).toBe("hello@example.com");
    expect(args.from).toBe("InterviewReplay <noreply@example.com>");
  });

  it("uses privacy@example.com as reply-to for category='privacy'", async () => {
    await sendEmail({ ...MINIMAL_ARGS, category: "privacy" });

    const args = resendSendMock.mock.calls[0]![0] as { replyTo: string };
    expect(args.replyTo).toBe("privacy@example.com");
  });

  it("uses founders@example.com as reply-to for category='feedback_acknowledgment'", async () => {
    // Feedback acks route to the founders inbox so users who reply reach
    // the founder personally, not the systematic feedback review queue.
    await sendEmail({ ...MINIMAL_ARGS, category: "feedback_acknowledgment" });

    const args = resendSendMock.mock.calls[0]![0] as { replyTo: string };
    expect(args.replyTo).toBe("founders@example.com");
  });

  it("uses founders@example.com as reply-to for category='founders'", async () => {
    await sendEmail({ ...MINIMAL_ARGS, category: "founders" });

    const args = resendSendMock.mock.calls[0]![0] as { replyTo: string };
    expect(args.replyTo).toBe("founders@example.com");
  });

  it("respects an explicit replyTo override regardless of category", async () => {
    await sendEmail({
      ...MINIMAL_ARGS,
      category: "general",
      replyTo: "submitter@example.com",
    });

    const args = resendSendMock.mock.calls[0]![0] as { replyTo: string };
    expect(args.replyTo).toBe("submitter@example.com");
  });

  it("always sends from noreply@example.com regardless of category", async () => {
    for (const category of [
      "general",
      "privacy",
      "feedback_acknowledgment",
      "founders",
    ] as const) {
      resendSendMock.mockClear();
      await sendEmail({ ...MINIMAL_ARGS, category });
      const args = resendSendMock.mock.calls[0]![0] as { from: string };
      expect(args.from).toBe("InterviewReplay <noreply@example.com>");
    }
  });

  it("includes an X-Entity-Ref-ID header for deduplication", async () => {
    await sendEmail({ ...MINIMAL_ARGS, category: "general" });

    const args = resendSendMock.mock.calls[0]![0] as {
      headers: Record<string, string>;
    };
    expect(args.headers?.["X-Entity-Ref-ID"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("returns dispatched=false and does not throw when Resend returns an error", async () => {
    resendSendMock.mockResolvedValue({
      data: null,
      error: { message: "invalid_api_key", name: "validation_error" },
    });

    const result = await sendEmail({ ...MINIMAL_ARGS, category: "general" });
    expect(result.dispatched).toBe(false);
    expect(result.id).toBeUndefined();
  });

  it("returns dispatched=false and does not throw when Resend throws", async () => {
    resendSendMock.mockRejectedValue(new Error("network timeout"));

    const result = await sendEmail({ ...MINIMAL_ARGS, category: "general" });
    expect(result.dispatched).toBe(false);
  });
});
