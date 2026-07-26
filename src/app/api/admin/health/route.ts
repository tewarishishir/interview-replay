import { NextResponse } from "next/server";

import { getAdminUser } from "@/lib/admin/auth";
import { getHealthSnapshot } from "@/lib/admin/health-queries";

/**
 * GET /api/admin/health
 *
 * Returns the full Product Health snapshot (AI quality, infra,
 * geo, engagement) as one JSON document. Same admin gate / 404
 * disclosure pattern as the other admin endpoints.
 *
 * Cache-Control: spec asks for 5 min. We use
 * `private, s-maxage=300, stale-while-revalidate=60` so the edge
 * serves the cached body for 5 min and revalidates in the
 * background for the next minute. The page route renders fresh
 * every load (this API is for external scripts).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const snapshot = await getHealthSnapshot();
  return NextResponse.json(snapshot, {
    status: 200,
    headers: {
      "Cache-Control": "private, s-maxage=300, stale-while-revalidate=60",
    },
  });
}
