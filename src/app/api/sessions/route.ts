import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { getActiveUserId } from "@/lib/auth/session";
import { ipFromHeaders, sessionCreateLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { createSession } from "@/lib/sessions/create";
import { createSessionPayloadSchema } from "@/lib/sessions/schemas";

/**
 * Cap the JSON body to a generous-but-bounded size. The schema only
 * accepts a handful of short strings; 16 KiB leaves comfortable
 * headroom for emoji-heavy company names and future scheduled-time
 * fields without giving an attacker an obvious memory-exhaustion
 * vector.
 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * POST /api/sessions
 *
 * Creates an `interview_sessions` row from the `/sessions/new` form.
 *
 * Pipeline (each step bails out cleanly on failure):
 *   1. Same-origin / Referer check (defense-in-depth on top of the
 *      `SameSite=lax` Auth.js cookie).
 *   2. Active-user check (`getActiveUserId` re-validates the JWT
 *      against the DB so soft-deleted users with a still-valid
 *      cookie can't keep writing).
 *   3. Per-user rate limit (30/hour) keyed by `userId`.
 *   4. JSON parse + Zod validation. The literal `consentAffirmed: true`
 *      is the legal gate — anything else returns 400.
 *   5. `createSession` writes the row + audit trail in one
 *      transaction. Any thrown error becomes a 500 with a stable
 *      error code rather than a leaked stack.
 *
 * Authorization is strictly "any active user can create sessions"
 * per spec; the row is unconditionally pinned to the authenticated
 * `userId` so a body-supplied `userId` field is harmless.
 */
export async function POST(request: Request): Promise<Response> {
  const h = await headers();

  // (1) Origin check. The Auth.js cookie is `SameSite=lax`, so a
  // cross-origin POST already wouldn't carry a session — but a
  // belt-and-suspenders origin allowlist costs nothing and means
  // a future change to `sameSite` doesn't silently re-open this
  // endpoint to CSRF.
  if (!isSameOrigin(h)) {
    return NextResponse.json(
      { error: "forbidden", message: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  // (2) Auth + revocation.
  const userId = await getActiveUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "You must be signed in." },
      { status: 401 },
    );
  }

  // (3) Rate limit. Keyed by userId — the caller is authenticated,
  // and per-IP would unfairly throttle multiple users behind a
  // shared egress (offices, VPNs).
  const limiter = sessionCreateLimiter();
  const limit = await limiter.check(userId);
  if (!limit.success) {
    const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many sessions started recently. Try again soon.",
        retryAfter,
      },
      {
        status: 429,
        // RFC 9111 / RFC 7231: surface the retry-after in seconds so
        // browsers and well-behaved clients can back off automatically.
        headers: { "Retry-After": String(retryAfter) },
      },
    );
  }

  // (4) Body size guard, then parse + schema validation.
  //
  // We honor `Content-Length` when the client sets it (cheap reject
  // path) and ALSO measure the actual text we read, so a chunked or
  // missing-header payload can't slip past. Anything over 16 KiB is
  // a clear bug or abuse attempt — the schema only accepts a handful
  // of short strings.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
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

  const parsed = createSessionPayloadSchema.safeParse(body);
  if (!parsed.success) {
    // Surface a flat field-error map; the form wires this into
    // per-field error pills. We do NOT echo the full ZodError —
    // its `path` arrays and codes are noise for the client.
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

  const { companyName, roleTitle, level, roundType, scheduledAt } = parsed.data;

  const ipAddress = ipFromHeaders(h);
  const userAgent = h.get("user-agent");

  // (5) DB write. Any thrown error here is an *infrastructure*
  // failure (FK race, dropped connection, exotic constraint) — log
  // server-side and return a stable error code instead of letting
  // Next.js render a generic 500 with the stack baked in.
  try {
    const row = await createSession({
      userId,
      companyName,
      roleTitle,
      level,
      roundType,
      scheduledAt: scheduledAt ?? null,
      ipAddress: ipAddress === "unknown-ip" ? null : ipAddress,
      userAgent,
    });

    return NextResponse.json(
      {
        session: {
          id: row.id,
          companyName: row.companyName,
          roleTitle: row.roleTitle,
          level: row.level,
          roundType: row.roundType,
          state: row.state,
          scheduledAt: row.scheduledAt?.toISOString() ?? null,
          consentAffirmedAt: row.consentAffirmedAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("[POST /api/sessions] create failed:", err);
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Could not create your session. Please try again.",
      },
      { status: 500 },
    );
  }
}

