import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { sendContactSubmissionEmail } from "@/lib/email";
import { contactSubmitLimiter, ipFromHeaders } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";

/**
 * POST /api/contact
 *
 * Public, unauthenticated endpoint that accepts a contact form
 * submission from the marketing `/contact` page and forwards it to
 * the operator inbox via Resend.
 *
 * Pre-flight pipeline:
 *
 *   1. Same-origin / Origin check — blocks cross-site form posters.
 *      Defense in depth on top of SameSite cookies (which the form
 *      doesn't even set, since the endpoint is anonymous).
 *   2. Per-IP rate limit (5 / hour) — the form is the classic
 *      spam-magnet shape, and unlike the auth endpoints it has no
 *      "wrong password" lockout layer to fall back on.
 *   3. Body size guard (10 KB ceiling). The form caps message body
 *      at ~5,000 chars on the client; the server cap is a defense
 *      against a maliciously large payload.
 *   4. Zod validation — email format, length caps on every field,
 *      mandatory presence of email + message.
 *   5. Honeypot — a hidden `_company` field that real browsers leave
 *      empty. Bots filling every text input flag themselves.
 *
 * The response is intentionally vague on the abuse rejections (429,
 * 400) so a bot can't easily differentiate "I tripped the limiter"
 * from "the message was rejected." The honeypot hit returns a
 * fake-success 200 so the bot moves on without retrying — the worst
 * UX for a bot, the same UX for a human (who can't see it anyway).
 *
 * Failure modes:
 *   - 503: Resend isn't configured. Surfaced in dev so a contributor
 *     hitting the form locally without `RESEND_API_KEY` understands
 *     why nothing landed in their Gmail.
 *   - 500: dispatch returned `dispatched: false` (Resend rejected,
 *     network error, etc.). Logged loudly on the server.
 */

export const runtime = "nodejs";

const MAX_BODY_BYTES = 10 * 1024;

const bodySchema = z.object({
  email: z.string().email().max(254),
  name: z.string().max(120).optional().nullable(),
  subject: z.string().min(1).max(160),
  message: z.string().min(10).max(5000),
  /**
   * Honeypot: rendered as a hidden text input named `company` on the
   * form. Real browsers leave it empty; bots that bind to every
   * `<input>` fill it in. A non-empty value here short-circuits with
   * a fake 200 so the bot doesn't retry.
   *
   * `_company` (with the underscore) so a future legitimate "company"
   * field on the form doesn't collide.
   */
  _company: z.string().max(120).optional().nullable(),
});

export async function POST(request: Request): Promise<Response> {
  const h = await headers();

  if (!isSameOrigin(h)) {
    return NextResponse.json(
      { error: "forbidden", message: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  const ip = ipFromHeaders(h) ?? "unknown-ip";
  const userAgent = h.get("user-agent")?.slice(0, 256) ?? "unknown-ua";

  const limiter = contactSubmitLimiter();
  const limit = await limiter.check(ip);
  if (!limit.success) {
    const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many submissions from this network. Try again later.",
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "Message is too large." },
      { status: 413 },
    );
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return NextResponse.json(
      { error: "bad_json", message: "Could not read request." },
      { status: 400 },
    );
  }
  if (bodyText.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "Message is too large." },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = bodyText.length === 0 ? {} : JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { error: "bad_json", message: "Body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join(".") || "_form";
      fieldErrors[key] ??= issue.message;
    }
    return NextResponse.json(
      { error: "validation_failed", fieldErrors },
      { status: 400 },
    );
  }

  // Honeypot hit. Return fake-success so the bot stops retrying and
  // logs nothing the operator needs to action.
  if (parsed.data._company && parsed.data._company.trim().length > 0) {
    console.warn(
      `[POST /api/contact] honeypot tripped (ip=${ip}, ua=${userAgent.slice(0, 64)})`,
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const result = await sendContactSubmissionEmail({
    fromEmail: parsed.data.email,
    fromName: parsed.data.name?.trim() || null,
    subject: parsed.data.subject,
    message: parsed.data.message,
    ipAddress: ip,
    userAgent,
  });

  if (!result.dispatched) {
    // Resend isn't configured or rejected. We don't surface the
    // distinction to the caller — both are operator problems. In
    // dev (no RESEND_API_KEY) the contact form will always 500
    // here; that's expected and the client renders a friendly
    // "couldn't send" notice.
    return NextResponse.json(
      {
        error: "send_failed",
        message:
          "We couldn't deliver your message. Please try again later or email hello@example.com directly.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
