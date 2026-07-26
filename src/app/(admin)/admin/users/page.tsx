import type { Metadata } from "next";

import { getAdminUser } from "@/lib/admin/auth";
import {
  DEFAULT_FILTERS,
  type ListUsersFilters,
  type UsersCountryFilter,
  type UsersDateRangeFilter,
  type UsersSortKey,
  type UsersStatusFilter,
  listUsers,
} from "@/lib/admin/users-queries";
import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { FiltersBar } from "@/components/admin/users/filters-bar";
import { Pagination } from "@/components/admin/users/pagination";
import { UsersTable } from "@/components/admin/users/users-table";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Users · InterviewReplay admin",
};

const STATUS_VALUES: readonly UsersStatusFilter[] = [
  "all",
  "free",
  "paying",
  "churned",
];
const COUNTRY_VALUES: readonly UsersCountryFilter[] = [
  "all",
  "india",
  "non_india",
];
const DATE_VALUES: readonly UsersDateRangeFilter[] = ["7d", "30d", "90d", "all"];
const SORT_VALUES: readonly UsersSortKey[] = [
  "recent_activity",
  "highest_spend",
  "session_count",
];

/**
 * Phase 2 — paginated user list.
 *
 * The page reads its filter state from the URL (`searchParams`),
 * which means every change to a filter dropdown reloads the page
 * with a new querystring. That keeps the page server-rendered end-
 * to-end (no client state to drift) AND bookmarkable (an operator
 * can pin "Sort by highest spend, last 30 days" in their browser).
 *
 * Unknown / malformed values for any filter param fall back to the
 * default — invalid input from a tampered URL renders the default
 * view rather than 400-ing.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await getAdminUser();
  const params = await searchParams;
  const filters = parseFilters(params);
  const result = await listUsers(filters);

  if (admin) {
    trackServerEvent({
      distinctId: admin.id,
      event: ANALYTICS_EVENTS.adminUsersViewed,
      properties: {
        filters_applied: serializeFiltersForAnalytics(filters),
      },
    });
  }

  // Strip `page` from the baseParams so pagination links carry the
  // current filter set but not stale page numbers.
  const baseParams = {
    status: filters.status === "all" ? null : filters.status,
    country: filters.country === "all" ? null : filters.country,
    date_range: filters.dateRange === DEFAULT_FILTERS.dateRange ? null : filters.dateRange,
    sort: filters.sort === DEFAULT_FILTERS.sort ? null : filters.sort,
    search: filters.search,
  };

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1
            className="text-2xl font-semibold"
            style={{ color: "var(--color-text-primary)" }}
          >
            Users
          </h1>
          <p
            className="mt-1 text-sm"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {result.totalCount.toLocaleString("en-IN")} match
            {result.totalCount === 1 ? "es" : ""} the current filters.
          </p>
        </div>
      </header>

      <div className="mt-4">
        <FiltersBar current={filters} />
      </div>

      <div className="mt-4">
        <UsersTable rows={result.rows} />
      </div>

      <div className="mt-4">
        <Pagination
          page={filters.page}
          totalCount={result.totalCount}
          pageSize={result.pageSize}
          baseParams={baseParams}
        />
      </div>
    </div>
  );
}

function parseFilters(
  params: Record<string, string | string[] | undefined>,
): ListUsersFilters {
  const single = (key: string): string | undefined => {
    const v = params[key];
    return Array.isArray(v) ? v[0] : v;
  };

  const status = single("status");
  const country = single("country");
  const dateRange = single("date_range");
  const sort = single("sort");
  const search = single("search")?.trim() || null;
  const pageNum = Number(single("page") ?? 1);

  return {
    status: (STATUS_VALUES as readonly string[]).includes(status ?? "")
      ? (status as UsersStatusFilter)
      : DEFAULT_FILTERS.status,
    country: (COUNTRY_VALUES as readonly string[]).includes(country ?? "")
      ? (country as UsersCountryFilter)
      : DEFAULT_FILTERS.country,
    dateRange: (DATE_VALUES as readonly string[]).includes(dateRange ?? "")
      ? (dateRange as UsersDateRangeFilter)
      : DEFAULT_FILTERS.dateRange,
    sort: (SORT_VALUES as readonly string[]).includes(sort ?? "")
      ? (sort as UsersSortKey)
      : DEFAULT_FILTERS.sort,
    search,
    page: Number.isFinite(pageNum) && pageNum >= 1 ? Math.floor(pageNum) : 1,
  };
}

function serializeFiltersForAnalytics(filters: ListUsersFilters): string {
  // Compact, sortable representation for the analytics event payload.
  // No free text (search query is omitted) so we never ship a user
  // email into analytics.
  const parts: string[] = [];
  if (filters.status !== "all") parts.push(`status=${filters.status}`);
  if (filters.country !== "all") parts.push(`country=${filters.country}`);
  if (filters.dateRange !== "30d") parts.push(`date=${filters.dateRange}`);
  if (filters.sort !== "recent_activity") parts.push(`sort=${filters.sort}`);
  if (filters.search) parts.push("search=yes");
  if (filters.page > 1) parts.push(`page=${filters.page}`);
  return parts.join(",") || "default";
}
