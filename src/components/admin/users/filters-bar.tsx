import type {
  ListUsersFilters,
  UsersCountryFilter,
  UsersDateRangeFilter,
  UsersSortKey,
  UsersStatusFilter,
} from "@/lib/admin/users-queries";

interface FiltersBarProps {
  current: ListUsersFilters;
}

const STATUS_OPTIONS: Array<{ value: UsersStatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "free", label: "Free" },
  { value: "paying", label: "Paying" },
  { value: "churned", label: "Churned (30d+)" },
];

const COUNTRY_OPTIONS: Array<{ value: UsersCountryFilter; label: string }> = [
  { value: "all", label: "All countries" },
  { value: "india", label: "India" },
  { value: "non_india", label: "Non-India" },
];

const DATE_RANGE_OPTIONS: Array<{ value: UsersDateRangeFilter; label: string }> = [
  { value: "7d", label: "Signed up · last 7 days" },
  { value: "30d", label: "Signed up · last 30 days" },
  { value: "90d", label: "Signed up · last 90 days" },
  { value: "all", label: "Signed up · all time" },
];

const SORT_OPTIONS: Array<{ value: UsersSortKey; label: string }> = [
  { value: "recent_activity", label: "Sort · most recent activity" },
  { value: "highest_spend", label: "Sort · highest spend" },
  { value: "session_count", label: "Sort · sessions count" },
];

/**
 * Server-rendered form for the `/admin/users` filter bar.
 *
 * Submits via native GET to `/admin/users`, which means the URL
 * query string is the source of truth for current filter state.
 * Two benefits:
 *   - Bookmarkable + shareable URLs (operator can pin a specific
 *     filter view in their browser).
 *   - No client-side state to manage — the page re-renders from
 *     the URL on every submission, no React state desync.
 *
 * The `page` field is intentionally omitted from the submission
 * (changing filters resets pagination to page 1).
 */
export function FiltersBar({ current }: FiltersBarProps) {
  return (
    <form
      action="/admin/users"
      method="get"
      className="flex flex-wrap items-center gap-2"
    >
      <Select name="status" value={current.status} options={STATUS_OPTIONS} />
      <Select name="country" value={current.country} options={COUNTRY_OPTIONS} />
      <Select name="date_range" value={current.dateRange} options={DATE_RANGE_OPTIONS} />
      <Select name="sort" value={current.sort} options={SORT_OPTIONS} />
      <input
        type="search"
        name="search"
        defaultValue={current.search ?? ""}
        placeholder="Search email or name…"
        className="rounded-md border px-3 py-1.5 text-sm"
        style={{
          background: "var(--color-bg-primary)",
          borderColor: "var(--color-border-secondary)",
          color: "var(--color-text-primary)",
          minWidth: "220px",
        }}
      />
      <button
        type="submit"
        className="rounded-md border px-3 py-1.5 text-sm transition-colors"
        style={{
          background: "var(--color-bg-tertiary)",
          borderColor: "var(--color-border-secondary)",
          color: "var(--color-text-primary)",
        }}
      >
        Apply
      </button>
    </form>
  );
}

interface SelectProps<T extends string> {
  name: string;
  value: T;
  options: Array<{ value: T; label: string }>;
}

function Select<T extends string>({ name, value, options }: SelectProps<T>) {
  return (
    <select
      name={name}
      defaultValue={value}
      className="rounded-md border px-3 py-1.5 text-sm"
      style={{
        background: "var(--color-bg-primary)",
        borderColor: "var(--color-border-secondary)",
        color: "var(--color-text-primary)",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
