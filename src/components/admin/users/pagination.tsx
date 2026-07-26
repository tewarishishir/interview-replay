import Link from "next/link";
import type { Route } from "next";

interface PaginationProps {
  page: number;
  totalCount: number;
  pageSize: number;
  /**
   * Map of the OTHER filter params (status, country, etc.). The
   * pagination links round-trip them so changing pages doesn't
   * drop the operator's active filter.
   */
  baseParams: Record<string, string | null>;
}

/**
 * Bare-bones pagination control: Prev / page-of-N indicator / Next.
 * Renders nothing when the dataset fits on one page — the count
 * line above the table is enough.
 *
 * The links carry every other filter param through unchanged so
 * stepping from page 2 to page 3 of "country=non_india" keeps the
 * country filter.
 */
export function Pagination({
  page,
  totalCount,
  pageSize,
  baseParams,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  if (totalPages <= 1) return null;

  const showing = Math.min(pageSize, totalCount - (page - 1) * pageSize);
  const buildHref = (target: number): Route => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(baseParams)) {
      if (v != null && v !== "") params.set(k, v);
    }
    params.set("page", String(target));
    return `/admin/users?${params.toString()}` as Route;
  };

  return (
    <div
      className="flex items-center justify-between text-sm"
      style={{ color: "var(--color-text-secondary)" }}
    >
      <span>
        Showing {showing} of {totalCount.toLocaleString("en-IN")} users
        {totalPages > 1 && (
          <>
            {" "}· page {page} of {totalPages}
          </>
        )}
      </span>
      <span className="flex items-center gap-2">
        <PageLink
          href={buildHref(Math.max(1, page - 1))}
          disabled={page <= 1}
          label="‹ Prev"
        />
        <PageLink
          href={buildHref(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          label="Next ›"
        />
      </span>
    </div>
  );
}

function PageLink({
  href,
  disabled,
  label,
}: {
  href: Route;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <span
        className="rounded-md border px-3 py-1 text-xs opacity-40"
        style={{
          borderColor: "var(--color-border-secondary)",
          color: "var(--color-text-tertiary)",
        }}
      >
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="rounded-md border px-3 py-1 text-xs"
      style={{
        borderColor: "var(--color-border-secondary)",
        color: "var(--color-text-secondary)",
      }}
    >
      {label}
    </Link>
  );
}
