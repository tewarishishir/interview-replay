import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { getActiveUserId } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { createFeedback } from "@/lib/feedback/persist";
import { feedbackCreateSchema } from "@/lib/feedback/schemas";
import { feedbackWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import {
  sendFeedbackAcknowledgmentEmail,
  sendInternalFeedbackNotificationEmail,
} from "@/lib/email/templates";

/**
 * `POST /api/feedback` — accept a feedback submission from the
 * floating widget rendered in every authenticated layout. The
 * request flow mirrors `POST /api/projects` (the canonical
 * small-write template): same-origin gate → auth → per-user
 * rate-limit → body size cap → JSON.parse → zod validate →
 * persist → emails (best-effort) → analytics event → 201.
 *
 * Emails are best-effort: a Resend failure does NOT roll back
 * the persisted row or return an error to the user. The feedback
 * is always saved; the admin queue remains the canonical view.
 *
 * Analytics: the success path fires `feedback_submitted` with
 * METADATA ONLY. The message body itself is never shipped to
 * analytics — the moderation queue inside the admin surface is
 * the right place to read what people actually wrote.
 */

export const runtime = "nodejs";

const MAX_BODY_BYTES = 32 * 1024;

export async function POST(request: Request): Promise<Response> {
  const h = await headers();
  if (!isSameOrigin(h)) {
    return NextResponse.json(
      { error: "forbidden", message: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  const userId = await getActiveUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "You must be signed in." },
      { status: 401 },
    );
  }

  const limit = await feedbackWriteLimiter().check(userId);
  if (!limit.success) {
    const retryAfter = Math.max(
      1,
      Math.ceil((limit.reset - Date.now()) / 1000),
    );
    return NextResponse.json(
      {
        error: "rate_limited",
        message:
          "Too many feedback submissions in a short window. Try again later.",
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "Request body is too large." },
      { status: 413 },
    );
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return NextResponse.json(
      { error: "bad_json", message: "Request body could not be read." },
      { status: 400 },
    );
  }
  if (bodyText.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "Request body is too large." },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = bodyText.length === 0 ? {} : JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { error: "bad_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = feedbackCreateSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join(".") || "_form";
      fieldErrors[key] ??= issue.message;
    }
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "One or more fields are invalid.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  try {
    const [row, userRow] = await Promise.all([
      createFeedback({ userId, data: parsed.data }),
      db
        .select({ email: schema.users.email, name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .then((rows) => rows[0] ?? null),
    ]);

    // Fire both emails in parallel, best-effort. A Resend failure only
    // logs — the feedback row is already persisted and the admin queue
    // remains the authoritative view. We intentionally don't await the
    // individual results because a slow Resend call should not delay
    // the 201 response to the user.
    if (userRow) {
      void Promise.all([
        sendInternalFeedbackNotificationEmail({
          userEmail: userRow.email,
          userName: userRow.name,
          rating: row.rating,
          message: row.message,
          pagePath: row.pagePath,
          submittedAt: row.createdAt,
        })
          .then((result) => {
            if (!result.dispatched) {
              console.error(
                "[POST /api/feedback] internal notification to feedback@example.com was not dispatched — " +
                  "check RESEND_API_KEY, EMAIL_FROM_ADDRESS, and Resend domain verification for localhost:3000",
              );
            }
          })
          .catch((err) => {
            console.error("[POST /api/feedback] internal notification failed:", err);
          }),
        sendFeedbackAcknowledgmentEmail({
          to: userRow.email,
          name: userRow.name,
        }).catch((err) => {
          console.error("[POST /api/feedback] acknowledgment email failed:", err);
        }),
      ]);
    } else {
      console.warn("[POST /api/feedback] user row not found for userId:", userId);
    }

    // Metadata-only payload — see file-level comment for why
    // the message body itself is never sent. `message_length`
    // is the closest proxy that's safe.
    trackServerEvent({
      distinctId: userId,
      event: ANALYTICS_EVENTS.feedbackSubmitted,
      properties: {
        rating: row.rating,
        message_length: row.message.length,
        has_consent: row.consentPublic,
        has_display_name: row.displayName !== null,
        page_path: row.pagePath,
      },
    });

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/feedback] create failed:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Could not submit feedback." },
      { status: 500 },
    );
  }
}
