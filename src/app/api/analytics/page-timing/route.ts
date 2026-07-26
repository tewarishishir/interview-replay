import { NextResponse } from "next/server";

import { getActiveUserId } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";

/**
 * POST /api/analytics/page-timing
 *
 * Receives client-side page performance measurements and stores
 * them in `audit_log` as `event_type = 'page.timing'`. The data
 * feeds the "Page Performance" section on the admin health page.
 *
 * Called by the `PageTimingTracker` component (client component in
 * the root layout) via `navigator.sendBeacon` on page unload / SPA
 * navigation, and via `fetch` as a fallback.
 *
 * Fields stored in `event_data`:
 *   - `pathname`      — The URL path (stripped of query/hash,
 *                       clamped to 200 chars).
 *   - `load_ms`       — `PerformanceNavigationTiming.loadEventEnd`
 *                       in ms. Non-null only for the initial hard
 *                       navigation; SPA route changes send null.
 *   - `time_spent_ms` — Visible time on the page (ms), capped at
 *                       1 hour. Computed from mount → unmount/unload
 *                       in the tracker component.
 *
 * Auth: requires a valid session cookie. Anonymous visits are
 * ignored (the tracker still fires but this route returns 204 so
 * the browser doesn't log a visible error).
 */
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const userId = await getActiveUserId();
  if (!userId) {
    // Return 204 (not 401) so the browser's sendBeacon call doesn't
    // trigger a visible console error for unauthenticated visitors.
    return new Response(null, { status: 204 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 204 });
  }

  if (!body || typeof body !== "object") {
    return new Response(null, { status: 204 });
  }

  const raw = body as Record<string, unknown>;

  const pathname =
    typeof raw.pathname === "string" && raw.pathname.length > 0
      ? raw.pathname.slice(0, 200)
      : null;

  if (!pathname) return new Response(null, { status: 204 });

  // load_ms: Navigation Timing loadEventEnd (ms). Null for SPA navigations.
  const loadMs =
    typeof raw.load_ms === "number" && raw.load_ms > 0 && raw.load_ms < 60_000
      ? Math.round(raw.load_ms)
      : null;

  // time_spent_ms: clamped to 1 hour.
  const timeSpentMs =
    typeof raw.time_spent_ms === "number" && raw.time_spent_ms >= 0
      ? Math.min(Math.round(raw.time_spent_ms), 3_600_000)
      : null;

  if (loadMs == null && timeSpentMs == null) {
    return new Response(null, { status: 204 });
  }

  try {
    await db.insert(schema.auditLog).values({
      userId,
      eventType: "page.timing",
      eventData: {
        pathname,
        load_ms: loadMs,
        time_spent_ms: timeSpentMs,
      },
    });
  } catch (err) {
    // Best-effort — a DB blip must not surface as an error to the user.
    console.error("[api/analytics/page-timing] write failed:", err);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
