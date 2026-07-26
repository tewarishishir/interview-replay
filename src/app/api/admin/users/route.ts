import { NextResponse } from "next/server";

import { getAdminUser } from "@/lib/admin/auth";
import {
  DEFAULT_FILTERS,
  type UsersCountryFilter,
  type UsersDateRangeFilter,
  type UsersSortKey,
  type UsersStatusFilter,
  listUsers,
} from "@/lib/admin/users-queries";

/**
 * GET /api/admin/users
 *
 * Same filter shape as `/admin/users` — useful for scripted
 * exports (the operator dumping "all non-India paying users from
 * the last 90 days" into a CSV via curl + jq). The HTML page is
 * still the primary surface; this endpoint just lets the data
 * out of the admin layout for downstream tooling.
 *
 * Unauthenticated / non-admin returns 404, NOT 401/403 — same
 * disclosure-minimizing pattern as `/api/admin/ops`.
 *
 * Not cached: filter combinations are too combinatorial for an
 * edge cache to win, and the list query already runs under 200ms.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS: readonly UsersStatusFilter[] = ["all", "free", "paying", "churned"];
const COUNTRY: readonly UsersCountryFilter[] = ["all", "india", "non_india"];
const DATE: readonly UsersDateRangeFilter[] = ["7d", "30d", "90d", "all"];
const SORT: readonly UsersSortKey[] = [
  "recent_activity",
  "highest_spend",
  "session_count",
];

export async function GET(req: Request): Promise<Response> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const sp = url.searchParams;

  const status = sp.get("status") ?? DEFAULT_FILTERS.status;
  const country = sp.get("country") ?? DEFAULT_FILTERS.country;
  const dateRange = sp.get("date_range") ?? DEFAULT_FILTERS.dateRange;
  const sort = sp.get("sort") ?? DEFAULT_FILTERS.sort;
  const search = sp.get("search")?.trim() || null;
  const pageRaw = Number(sp.get("page") ?? 1);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;

  const result = await listUsers({
    status: (STATUS as readonly string[]).includes(status)
      ? (status as UsersStatusFilter)
      : DEFAULT_FILTERS.status,
    country: (COUNTRY as readonly string[]).includes(country)
      ? (country as UsersCountryFilter)
      : DEFAULT_FILTERS.country,
    dateRange: (DATE as readonly string[]).includes(dateRange)
      ? (dateRange as UsersDateRangeFilter)
      : DEFAULT_FILTERS.dateRange,
    sort: (SORT as readonly string[]).includes(sort)
      ? (sort as UsersSortKey)
      : DEFAULT_FILTERS.sort,
    search,
    page,
  });

  return NextResponse.json(result, { status: 200 });
}
