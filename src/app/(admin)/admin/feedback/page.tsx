import Link from "next/link";
import type { Metadata, Route } from "next";
import { Star } from "lucide-react";
import { LocalTime } from "@/components/ui/local-time";

import { getAdminUser } from "@/lib/admin/auth";
import {
  countFeedbackByStatus,
  listFeaturedFeedback,
  listFeedback,
  type FeaturedFeedbackRow,
} from "@/lib/feedback/admin-queries";
import {
  FEEDBACK_STATUSES,
  type FeedbackStatus,
} from "@/lib/db/schema";
import { FEATURED_TESTIMONIALS_MAX } from "@/lib/feedback/schemas";
import { FeedbackActions } from "@/components/admin/feedback/feedback-actions";
import { FeaturedRowControls } from "@/components/admin/feedback/featured-row-controls";

/**
 * Admin moderation queue for the feedback widget.
 *
 * URL state:
 *   - `?status=pending|approved|rejected` filters the queue.
 *   - No `?status` (or any other value) renders the "All" view.
 *
 * The page is server-rendered end-to-end, mirroring `/admin/users`
 * — filter changes round-trip via the chip links below, which
 * keeps the page bookmarkable AND lets the audit log capture
 * which filter the admin was using when they took an action.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Feedback · InterviewReplay admin",
};

const PAGE_SIZE = 50;

function parseStatusParam(raw: string | string[] | undefined): FeedbackStatus | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return "pending";
  if (value === "all") return null;
  return (FEEDBACK_STATUSES as readonly string[]).includes(value)
    ? (value as FeedbackStatus)
    : "pending";
}

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The (admin) layout already gates `is_admin = true`. This call
  // is for the type-narrow (and the `id` for any future inline
  // action that wants to attribute to the current admin).
  await getAdminUser();

  const params = await searchParams;
  const statusFilter = parseStatusParam(params.status);
  const [{ rows, totalCount }, counts, featuredRows] = await Promise.all([
    listFeedback({ status: statusFilter, limit: PAGE_SIZE }),
    countFeedbackByStatus(),
    listFeaturedFeedback(),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1
            className="text-2xl font-semibold"
            style={{ color: "var(--color-text-primary)" }}
          >
            Feedback
          </h1>
          <p
            className="mt-1 text-sm"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {totalCount.toLocaleString("en-IN")} entr
            {totalCount === 1 ? "y" : "ies"} in this view. Approve the
            best ones to feature them on the home page.
          </p>
        </div>
      </header>

      <FeaturedSection rows={featuredRows} />

      <FilterChips active={statusFilter} counts={counts} />

      {rows.length === 0 ? (
        <div
          className="mt-6 rounded-lg border px-6 py-12 text-center"
          style={{
            borderColor: "var(--color-border-tertiary)",
            background: "var(--color-bg-secondary)",
          }}
        >
          <p
            className="text-sm"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Nothing here yet.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table
            className="w-full border-collapse text-sm"
            style={{ color: "var(--color-text-primary)" }}
          >
            <thead>
              <tr
                className="text-left text-xs uppercase tracking-wide"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                <th className="py-2 pr-4">Rating</th>
                <th className="py-2 pr-4">Message</th>
                <th className="py-2 pr-4">From</th>
                <th className="py-2 pr-4">Submitted</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pl-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-t align-top"
                  style={{ borderColor: "var(--color-border-tertiary)" }}
                >
                  <td className="py-3 pr-4">
                    <RatingStars value={row.rating} />
                  </td>
                  <td className="py-3 pr-4">
                    <p className="max-w-md text-sm leading-relaxed whitespace-pre-wrap">
                      {row.message}
                    </p>
                    <ConsentBadge
                      consent={row.consentPublic}
                      displayName={row.displayName}
                      displayRole={row.displayRole}
                    />
                  </td>
                  <td className="py-3 pr-4">
                    <div className="text-sm">
                      {row.submitterDisplayName?.trim() || (
                        <span
                          style={{ color: "var(--color-text-tertiary)" }}
                        >
                          (no display name)
                        </span>
                      )}
                    </div>
                    <div
                      className="text-xs"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {row.submitterEmail}
                    </div>
                    {row.pagePath && (
                      <div
                        className="mt-0.5 text-xs"
                        style={{ color: "var(--color-text-tertiary)" }}
                      >
                        from{" "}
                        <code className="font-mono">{row.pagePath}</code>
                      </div>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    <time
                      dateTime={row.createdAt.toISOString()}
                      className="text-xs"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      <LocalTime
                        date={row.createdAt}
                        options={{ dateStyle: "medium", timeStyle: "short" }}
                      />
                    </time>
                  </td>
                  <td className="py-3 pr-4">
                    <StatusBadge
                      status={row.status as FeedbackStatus}
                      approverEmail={row.approverEmail}
                    />
                  </td>
                  <td className="py-3 pl-4">
                    <FeedbackActions
                      id={row.id}
                      status={row.status as FeedbackStatus}
                      consentPublic={row.consentPublic}
                      featured={row.featured}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Curation tray at the top of the admin page. Renders the rows
 * currently featured on the marketing home page, in their display
 * order, with per-row up/down/unfeature controls.
 *
 * Empty state renders deliberately quiet (a single line) — the
 * admin's primary attention is on the moderation queue below; the
 * tray is only loud when there's something to curate.
 *
 * The "N / MAX" counter doubles as a cap visualizer — when it
 * reaches the cap the admin knows new Feature clicks will 409
 * until they unfeature something.
 */
function FeaturedSection({ rows }: { rows: FeaturedFeedbackRow[] }) {
  const count = rows.length;
  return (
    <section
      className="mt-6 rounded-lg border px-4 py-4"
      style={{
        borderColor: "var(--color-border-tertiary)",
        background: "var(--color-bg-secondary)",
      }}
      aria-labelledby="featured-section-heading"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="featured-section-heading"
          className="text-sm font-semibold"
          style={{ color: "var(--color-text-primary)" }}
        >
          On the home page
          <span
            className="ml-2 text-xs font-normal"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {count} / {FEATURED_TESTIMONIALS_MAX}
          </span>
        </h2>
        <p
          className="text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Pick from approved feedback to surface on the marketing page.
          Drag-free reorder with the arrows.
        </p>
      </header>

      {count === 0 ? (
        <p
          className="mt-3 text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Nothing featured yet. Approve a row below and click{" "}
          <span
            className="rounded border px-1 py-0.5 text-[10px]"
            style={{ borderColor: "var(--color-border-tertiary)" }}
          >
            Feature
          </span>{" "}
          to add it here.
        </p>
      ) : (
        <ol className="mt-3 space-y-2">
          {rows.map((row, idx) => (
            <li
              key={row.id}
              className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
              style={{
                borderColor: "var(--color-border-tertiary)",
                background: "var(--color-bg-primary)",
              }}
            >
              <div className="flex min-w-0 items-start gap-3">
                <span
                  className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium"
                  style={{
                    background: "var(--color-bg-tertiary)",
                    color: "var(--color-text-secondary)",
                  }}
                  aria-label={`Position ${idx + 1}`}
                >
                  {idx + 1}
                </span>
                <div className="min-w-0">
                  <p
                    className="line-clamp-2 text-xs leading-relaxed"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    &ldquo;{row.message}&rdquo;
                  </p>
                  <p
                    className="mt-1 text-[11px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {row.displayName?.trim() ||
                      row.submitterDisplayName?.trim() ||
                      row.submitterEmail}
                    {row.displayRole?.trim() ? ` · ${row.displayRole}` : ""}
                  </p>
                </div>
              </div>
              <FeaturedRowControls
                id={row.id}
                isFirst={idx === 0}
                isLast={idx === rows.length - 1}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function FilterChips({
  active,
  counts,
}: {
  active: FeedbackStatus | null;
  counts: Record<FeedbackStatus, number>;
}) {
  const chips: Array<{
    label: string;
    href: Route;
    isActive: boolean;
    count?: number;
  }> = [
    {
      label: "Pending",
      href: "/admin/feedback?status=pending" as Route,
      isActive: active === "pending",
      count: counts.pending,
    },
    {
      label: "Approved",
      href: "/admin/feedback?status=approved" as Route,
      isActive: active === "approved",
      count: counts.approved,
    },
    {
      label: "Rejected",
      href: "/admin/feedback?status=rejected" as Route,
      isActive: active === "rejected",
      count: counts.rejected,
    },
    {
      label: "All",
      href: "/admin/feedback?status=all" as Route,
      isActive: active === null,
    },
  ];

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <Link
          key={chip.href}
          href={chip.href}
          className="rounded-full border px-3 py-1 text-xs font-medium transition-colors"
          style={{
            background: chip.isActive
              ? "var(--color-bg-tertiary)"
              : "transparent",
            borderColor: chip.isActive
              ? "var(--color-border-primary)"
              : "var(--color-border-tertiary)",
            color: chip.isActive
              ? "var(--color-text-primary)"
              : "var(--color-text-secondary)",
          }}
        >
          {chip.label}
          {chip.count !== undefined && chip.count > 0 && (
            <span
              className="ml-1"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              ({chip.count})
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}

function RatingStars({ value }: { value: number }) {
  return (
    <div
      className="inline-flex items-center gap-0.5"
      aria-label={`${value} out of 5`}
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={
            i <= value
              ? "size-3.5 fill-amber-400 text-amber-500"
              : "size-3.5 text-muted-foreground/40"
          }
          aria-hidden
        />
      ))}
    </div>
  );
}

function ConsentBadge({
  consent,
  displayName,
  displayRole,
}: {
  consent: boolean;
  displayName: string | null;
  displayRole: string | null;
}) {
  if (!consent) return null;
  return (
    <div
      className="mt-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
      style={{
        borderColor: "var(--color-border-tertiary)",
        background: "var(--color-bg-secondary)",
        color: "var(--color-text-secondary)",
      }}
      title="The user consented to having this featured publicly."
    >
      OK to feature
      {displayName?.trim() && (
        <span style={{ color: "var(--color-text-tertiary)" }}>
          · as &ldquo;{displayName}
          {displayRole?.trim() ? `, ${displayRole}` : ""}&rdquo;
        </span>
      )}
    </div>
  );
}

function StatusBadge({
  status,
  approverEmail,
}: {
  status: FeedbackStatus;
  approverEmail: string | null;
}) {
  const label =
    status === "approved"
      ? "Approved"
      : status === "rejected"
        ? "Rejected"
        : "Pending";
  const tone =
    status === "approved"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
      : status === "rejected"
        ? "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300"
        : "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300";
  return (
    <div className="flex flex-col items-start gap-1">
      <span
        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}
      >
        {label}
      </span>
      {status === "approved" && approverEmail && (
        <span
          className="text-[10px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          by {approverEmail}
        </span>
      )}
    </div>
  );
}

