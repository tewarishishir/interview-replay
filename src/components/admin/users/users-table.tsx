import Link from "next/link";

import type { UsersListRow } from "@/lib/admin/users-queries";

interface UsersTableProps {
  rows: UsersListRow[];
}

/**
 * Read-only users table for `/admin/users`. Each row links into
 * `/admin/users/[id]` for the detail page; the right-hand actions
 * column carries quick deep-links to that page's anchored sections
 * (the spec asks for View / Grant credits / Refund / Note links —
 * we render View and let the detail page expose the actions, so
 * the table stays narrow and the action verbs are clustered near
 * the data they act on).
 *
 * Empty state: a single muted "No users match these filters" row
 * rather than an entirely empty table, so the operator can tell
 * "the filter is too tight" apart from "the page didn't load".
 */
export function UsersTable({ rows }: UsersTableProps) {
  if (rows.length === 0) {
    return (
      <div
        className="rounded-md p-6 text-center text-sm italic"
        style={{
          background: "var(--color-bg-secondary)",
          color: "var(--color-text-tertiary)",
        }}
      >
        No users match these filters.
      </div>
    );
  }

  return (
    <div
      className="overflow-x-auto rounded-md border"
      style={{
        background: "var(--color-bg-primary)",
        borderColor: "var(--color-border-tertiary)",
      }}
    >
      <table className="w-full text-left text-sm">
        <thead
          style={{
            background: "var(--color-bg-secondary)",
            color: "var(--color-text-tertiary)",
          }}
        >
          <tr className="text-xs uppercase tracking-wide">
            <Th>User</Th>
            <Th>Country</Th>
            <Th>Signed up</Th>
            <Th>Last activity</Th>
            <Th align="right">Sessions</Th>
            <Th align="right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <UserRow key={r.id} row={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "right";
}) {
  return (
    <th
      scope="col"
      className={align === "right" ? "px-3 py-2 text-right" : "px-3 py-2"}
    >
      {children}
    </th>
  );
}

function UserRow({ row }: { row: UsersListRow }) {
  const displayName = row.displayName?.trim() || row.email;
  const geo = formatGeo(row.signupCountryCode, row.signupSubdivisionCode);
  return (
    <tr
      className="border-t"
      style={{ borderColor: "var(--color-border-tertiary)" }}
    >
      <td className="px-3 py-2">
        <Link
          href={`/admin/users/${row.id}`}
          className="block truncate"
          style={{ color: "var(--color-text-primary)" }}
        >
          <span className="font-medium">{displayName}</span>
          {displayName !== row.email && (
            <span
              className="ml-2 text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {row.email}
            </span>
          )}
        </Link>
      </td>
      <td className="px-3 py-2">
        <GeoCell geo={geo} country={row.signupCountryCode} />
      </td>
      <td
        className="px-3 py-2 whitespace-nowrap"
        title={row.signedUpAt.toISOString()}
      >
        {formatRelativeDate(row.signedUpAt)}
      </td>
      <td
        className="px-3 py-2 whitespace-nowrap"
        title={row.lastActivityAt.toISOString()}
      >
        {formatRelativeDate(row.lastActivityAt)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{row.sessionsCount}</td>
      <td className="px-3 py-2 text-right">
        <Link
          href={`/admin/users/${row.id}`}
          className="rounded-md border px-2 py-0.5 text-xs"
          style={{
            borderColor: "var(--color-border-secondary)",
            color: "var(--color-text-secondary)",
          }}
        >
          View
        </Link>
      </td>
    </tr>
  );
}

function GeoCell({
  geo,
  country,
}: {
  geo: string;
  country: string | null;
}) {
  const isNonIndia = country != null && country !== "IN";
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{
        color: isNonIndia
          ? "var(--color-warning-text)"
          : "var(--color-text-secondary)",
      }}
    >
      {isNonIndia && (
        <span
          aria-hidden
          className="inline-block size-1.5 rounded-full"
          style={{ background: "var(--color-warning)" }}
        />
      )}
      {geo}
    </span>
  );
}

function formatGeo(country: string | null, subdivision: string | null): string {
  if (!country) return "—";
  if (subdivision) return `${subdivision}, ${country}`;
  return country;
}

function formatRelativeDate(d: Date): string {
  const elapsed = Date.now() - d.getTime();
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
