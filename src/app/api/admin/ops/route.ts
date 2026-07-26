import { NextResponse } from "next/server";

import { getAdminUser } from "@/lib/admin/auth";
import { getOpsSnapshot } from "@/lib/admin/ops-snapshot";

/**
 * GET /api/admin/ops
 *
 * Returns the full Daily Ops snapshot (today metrics, yesterday
 * deltas, 7-day trend, 30-day funnel, revenue/cost, health alerts)
 * as one JSON document.
 *
 * Gate: same `users.is_admin` check the (admin) layout uses. A
 * non-admin gets a generic 404 — no "you're not authorized"
 * disclosure, matching the layout's redirect-to-/dashboard story.
 *
 * Cache-Control: the spec asks for 60s. We use
 * `s-maxage=60, stale-while-revalidate=30` so an edge cache
 * serves the cached body for 60s and revalidates in the background
 * for the next 30s. `private` so a shared CDN never caches an
 * admin's view in a path where another admin could pick it up
 * across accounts.
 *
 * In-page refreshes use `router.refresh()` on the (admin)/ops
 * server component (see `components/admin/ops/refresh-button.tsx`)
 * — this API route is intended for external/scripted consumers
 * (e.g. a Slack daily digest job).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const admin = await getAdminUser();
  if (!admin) {
    // 404 (not 403) so anonymous probes can't enumerate the
    // existence of admin endpoints.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const snapshot = await getOpsSnapshot();
  return NextResponse.json(snapshot, {
    status: 200,
    headers: {
      "Cache-Control": "private, s-maxage=60, stale-while-revalidate=30",
    },
  });
}
