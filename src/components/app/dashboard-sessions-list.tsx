"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  AlertTriangle,
  CalendarDays,
  CheckSquare,
  CoinsIcon,
  LayoutGrid,
  List as ListIcon,
  Loader2,
  Square,
  Trash2,
  X,
} from "lucide-react";

import { CompanyLogo } from "@/components/app/company-logo";

import type { SessionListItem } from "@/lib/queries/sessions";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SessionCard } from "@/components/app/session-card";
import { SessionRow } from "@/components/app/session-row";
import { cn } from "@/lib/utils";

interface DashboardSessionsListProps {
  sessions: SessionListItem[];
}

interface DeleteResponse {
  ok?: boolean;
  alreadyDeleted?: boolean;
  message?: string;
}

/**
 * Reason a per-row delete failed. Surfaced in the user-facing error
 * banner so the message can be specific (rate-limited vs server vs
 * network) rather than a generic "couldn't delete".
 */
type FailureKind = "rate_limited" | "server" | "network";

type ViewMode = "grid" | "list";
type GroupMode = "none" | "year" | "month" | "company";
type SortMode = "newest" | "oldest";

const VIEW_STORAGE_KEY = "ir:dashboard:view";
const GROUP_STORAGE_KEY = "ir:dashboard:group";
const SORT_STORAGE_KEY = "ir:dashboard:sort";

const VIEW_MODES: readonly ViewMode[] = ["grid", "list"] as const;
const GROUP_MODES: readonly GroupMode[] = [
  "none",
  "year",
  "month",
  "company",
] as const;
const SORT_MODES: readonly SortMode[] = ["newest", "oldest"] as const;

/**
 * Narrow an arbitrary `localStorage` value to one of the allowed
 * tokens, returning `fallback` for anything else. Centralized so
 * the three preferences all use the same safe parse path.
 */
function parsePreference<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

/**
 * Compose a stable group key + a display label for a session given
 * the current grouping mode. The key drives ordering and bucketing;
 * the label is what the section header renders.
 *
 * Keys are intentionally sortable lexicographically (e.g. `2026-05`
 * sorts correctly under "month" without parsing) so the group
 * ordering reduces to a `localeCompare` on the key string.
 */
function groupForSession(
  session: SessionListItem,
  mode: GroupMode,
): { key: string; label: string } | null {
  if (mode === "none") return null;
  if (mode === "year") {
    const key = format(session.createdAt, "yyyy");
    return { key, label: key };
  }
  if (mode === "month") {
    return {
      key: format(session.createdAt, "yyyy-MM"),
      label: format(session.createdAt, "MMMM yyyy"),
    };
  }
  // company — use a lowercased key so "Google" and "google" bucket
  // together even though they'd render with the original casing.
  return {
    key: session.companyName.toLowerCase(),
    label: session.companyName,
  };
}

/**
 * Dashboard "Sessions" list. Renders the user's interview history
 * with three orthogonal controls layered on top:
 *
 *   - View mode (grid | list)
 *   - Grouping (none | year | month | company)
 *   - Sort order (newest | oldest by `createdAt`)
 *
 * All three are persisted to `localStorage` so a returning user
 * sees their preferred shape on next load. The persistence is
 * per-browser by design — these are presentation choices and don't
 * warrant a server round-trip.
 *
 * Bulk select / soft-delete works identically across both view
 * modes: tapping "Select" turns every card or row into a toggle
 * button and reveals a delete bar. The delete loop walks the
 * selected ids sequentially against `DELETE /api/sessions/:id` —
 * see the original commit message for why we don't parallelize.
 */
export function DashboardSessionsList({
  sessions,
}: DashboardSessionsListProps) {
  const router = useRouter();
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // `notice` carries a non-error confirmation message. It survives
  // `exitSelectMode` so the user actually gets to read it after the
  // toolbar collapses. Cleared on the next `enterSelectMode`.
  const [notice, setNotice] = useState<string | null>(null);

  // View / group / sort preferences. Hydrated from `localStorage`
  // on mount (kept as defaults during SSR so server-rendered HTML
  // matches the first client paint — no hydration warning).
  const [view, setView] = useState<ViewMode>("grid");
  const [group, setGroup] = useState<GroupMode>("none");
  const [sort, setSort] = useState<SortMode>("newest");

  useEffect(() => {
    try {
      setView(
        parsePreference(localStorage.getItem(VIEW_STORAGE_KEY), VIEW_MODES, "grid"),
      );
      setGroup(
        parsePreference(
          localStorage.getItem(GROUP_STORAGE_KEY),
          GROUP_MODES,
          "none",
        ),
      );
      setSort(
        parsePreference(localStorage.getItem(SORT_STORAGE_KEY), SORT_MODES, "newest"),
      );
    } catch {
      // localStorage may throw in private mode / SameSite-restricted
      // contexts. Defaults already cover us.
    }
  }, []);

  const updateView = useCallback((next: ViewMode) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort.
    }
  }, []);

  const updateGroup = useCallback((next: GroupMode) => {
    setGroup(next);
    try {
      localStorage.setItem(GROUP_STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort.
    }
  }, []);

  const updateSort = useCallback((next: SortMode) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort.
    }
  }, []);

  const selectableIds = useMemo(
    () => sessions.map((s) => s.id),
    [sessions],
  );

  const selectedCount = selectedIds.size;
  const allSelected =
    selectableIds.length > 0 && selectedCount === selectableIds.length;

  // O(n) lookup of session state by id. The bulk-delete confirmation
  // needs to count how many selected sessions are in `review` state
  // (those may incur a transcription fee server-side); rebuilding the
  // map once per `sessions` change is cheaper than scanning the array
  // every time selection changes.
  const stateById = useMemo(() => {
    const map = new Map<string, SessionListItem["state"]>();
    for (const s of sessions) map.set(s.id, s.state);
    return map;
  }, [sessions]);

  // Apply sort (always by `createdAt`) and bucket by the active
  // grouping mode. When the mode is "none" we return a single group
  // with a `null` label so the renderer can skip the section header.
  const groupedSessions = useMemo(() => {
    const dir = sort === "newest" ? -1 : 1;
    const sorted = [...sessions].sort(
      (a, b) =>
        dir * (a.createdAt.getTime() - b.createdAt.getTime()),
    );

    if (group === "none") {
      return [{ key: "all", label: null as string | null, items: sorted }];
    }

    const buckets = new Map<
      string,
      { key: string; label: string; items: SessionListItem[] }
    >();
    for (const session of sorted) {
      const g = groupForSession(session, group);
      if (!g) continue;
      const bucket = buckets.get(g.key);
      if (bucket) {
        bucket.items.push(session);
      } else {
        buckets.set(g.key, { key: g.key, label: g.label, items: [session] });
      }
    }

    // Order group headers. Time-based groups follow the sort
    // direction (newest year/month first when sort=newest);
    // company groups are alphabetical so the list stays predictable
    // regardless of date sort.
    const ordered = Array.from(buckets.values());
    if (group === "company") {
      ordered.sort((a, b) => a.label.localeCompare(b.label));
    } else {
      ordered.sort((a, b) =>
        sort === "newest" ? b.key.localeCompare(a.key) : a.key.localeCompare(b.key),
      );
    }
    return ordered.map((g) => ({ ...g, label: g.label as string | null }));
  }, [sessions, group, sort]);

  const enterSelectMode = useCallback(() => {
    setError(null);
    setNotice(null);
    setSelectMode(true);
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setError(null);
    // Intentionally NOT clearing `notice` — it carries the
    // post-delete confirmation and needs to survive the toolbar
    // collapse so the user can read it.
  }, []);

  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === selectableIds.length) {
        return new Set();
      }
      return new Set(selectableIds);
    });
  }, [selectableIds]);

  const handleBulkDelete = useCallback(() => {
    if (selectedCount === 0) return;

    const baseMessage =
      selectedCount === 1
        ? "Delete this session? The transcript and report will be removed."
        : `Delete ${selectedCount} sessions? Transcripts and reports for the selected sessions will be removed.`;

    const fullMessage = baseMessage;

    if (!window.confirm(fullMessage)) return;

    setError(null);
    setNotice(null);
    // Snapshot the selection at confirm-time. The user can no longer
    // toggle cards while `pending` is true (the SessionCard buttons
    // are `disabled`), so this snapshot stays in sync with what the
    // user just confirmed even if a server-component refresh fires
    // before we settle.
    const ids = Array.from(selectedIds);

    startTransition(async () => {
      const failures: { id: string; kind: FailureKind; message: string }[] = [];
      let rateLimited = false;

      for (const id of ids) {
        try {
          // Defensive encoding. UUIDs are URL-safe today, but the
          // server treats `[id]` as a single path segment — encoding
          // here protects us against future id format changes that
          // could otherwise produce path-traversal-ish surprises.
          const res = await fetch(
            `/api/sessions/${encodeURIComponent(id)}`,
            {
              method: "DELETE",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
            },
          );
          const data = (await res
            .json()
            .catch(() => ({}))) as DeleteResponse;

          if (res.ok) {
            continue;
          }

          if (res.status === 429) {
            // Rate-limited — stop early so we don't pile up more
            // failures and so the user sees a clear, actionable
            // message instead of N copies of "HTTP 429".
            rateLimited = true;
            failures.push({
              id,
              kind: "rate_limited",
              message: data.message ?? "Too many delete requests.",
            });
            break;
          }

          failures.push({
            id,
            kind: "server",
            message: data.message ?? `Server returned ${res.status}.`,
          });
        } catch (err) {
          console.error("[DashboardSessionsList] delete failed:", err);
          failures.push({
            id,
            kind: "network",
            message: "Network error",
          });
        }
      }

      // Always refresh — even when every row failed, a concurrent
      // delete from another tab may have flipped some rows to
      // `deleted` and we want the grid to reflect the truth.
      router.refresh();

      const succeeded = ids.length - failures.length;
      // Drop the successfully-deleted ids from the selection so a
      // retry click only re-attempts the failed rows. When we
      // bailed out on rate-limit, also keep the un-attempted ids
      // so the user can retry the full remaining set after the
      // window opens.
      const attemptedIds = new Set(failures.map((f) => f.id));
      if (rateLimited) {
        const failedIdSet = new Set(failures.map((f) => f.id));
        const firstFailedIdx = ids.findIndex((id) => failedIdSet.has(id));
        if (firstFailedIdx >= 0) {
          for (let i = firstFailedIdx; i < ids.length; i++) {
            const id = ids[i];
            if (id) attemptedIds.add(id);
          }
        }
      }
      setSelectedIds(attemptedIds);

      if (failures.length === 0) {
        exitSelectMode();
        return;
      }

      // Build a single, specific message. Pick the most informative
      // error in the failure set (prefer rate-limit since it's
      // actionable; otherwise the first server/network message).
      const firstFailure =
        failures.find((f) => f.kind === "rate_limited") ?? failures[0];
      const failedCount = rateLimited
        ? attemptedIds.size
        : failures.length;

      if (succeeded === 0) {
        setError(
          `Couldn't delete ${failedCount} ${
            failedCount === 1 ? "session" : "sessions"
          }: ${firstFailure?.message ?? "unknown error"}`,
        );
      } else {
        setError(
          `Deleted ${succeeded}, but ${failedCount} ${
            failedCount === 1 ? "session" : "sessions"
          } failed: ${firstFailure?.message ?? "unknown error"}`,
        );
      }
    });
  }, [
    exitSelectMode,
    router,
    selectedCount,
    selectedIds,
  ]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {selectMode
            ? `${selectedCount} selected of ${sessions.length}`
            : "Sessions"}
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          {selectMode ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={toggleAll}
                disabled={pending || sessions.length === 0}
              >
                {allSelected ? (
                  <>
                    <Square className="size-4" aria-hidden />
                    Clear
                  </>
                ) : (
                  <>
                    <CheckSquare className="size-4" aria-hidden />
                    Select all
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={exitSelectMode}
                disabled={pending}
              >
                <X className="size-4" aria-hidden />
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/5"
                style={{ color: "rgb(190, 18, 60)" }}
                disabled={pending || selectedCount === 0}
                onClick={handleBulkDelete}
              >
                {pending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Deleting…
                  </>
                ) : (
                  <>
                    <Trash2 className="size-4" aria-hidden />
                    Delete
                    {selectedCount > 0 ? ` (${selectedCount})` : ""}
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              {/* View / group / sort controls. Only meaningful when
                  there's at least one session — hiding them for the
                  empty-state path keeps the toolbar visually clean. */}
              {sessions.length > 0 && (
                <>
                  <div
                    role="group"
                    aria-label="View mode"
                    className="inline-flex items-center rounded-md border border-border bg-background p-0.5"
                  >
                    <button
                      type="button"
                      onClick={() => updateView("grid")}
                      aria-pressed={view === "grid"}
                      aria-label="Grid view"
                      className={cn(
                        "inline-flex h-7 items-center justify-center rounded px-2 transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
                        view === "grid"
                          ? "bg-primary/15 text-primary"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <LayoutGrid className="size-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => updateView("list")}
                      aria-pressed={view === "list"}
                      aria-label="List view"
                      className={cn(
                        "inline-flex h-7 items-center justify-center rounded px-2 transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
                        view === "list"
                          ? "bg-primary/15 text-primary"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <ListIcon className="size-4" aria-hidden />
                    </button>
                  </div>

                  <Select
                    value={group}
                    onValueChange={(v) => updateGroup(v as GroupMode)}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label="Group sessions by"
                      className="h-8 text-xs"
                    >
                      <span className="text-muted-foreground">Group: </span>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="year">Year</SelectItem>
                      <SelectItem value="month">Month</SelectItem>
                      <SelectItem value="company">Company</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select
                    value={sort}
                    onValueChange={(v) => updateSort(v as SortMode)}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label="Sort sessions by date"
                      className="h-8 text-xs"
                    >
                      <span className="text-muted-foreground">Sort: </span>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="newest">Newest first</SelectItem>
                      <SelectItem value="oldest">Oldest first</SelectItem>
                    </SelectContent>
                  </Select>
                </>
              )}

              <p className="text-xs text-muted-foreground">
                {sessions.length} total
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={enterSelectMode}
                disabled={sessions.length === 0}
              >
                <CheckSquare className="size-4" aria-hidden />
                Select
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 inline-flex items-center gap-1.5 text-xs"
          style={{ color: "rgb(190, 18, 60)" }}
        >
          <AlertTriangle className="size-3.5" aria-hidden />
          {error}
        </p>
      )}

      {notice && !error && (
        <p
          // `status` (not `alert`) so screen readers announce it as a
          // polite update — this is a confirmation, not a failure.
          role="status"
          className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <CoinsIcon className="size-3.5" aria-hidden />
          {notice}
        </p>
      )}

      <div className="mt-4 space-y-8">
        {groupedSessions.map((bucket) => (
          <section key={bucket.key} aria-label={bucket.label ?? undefined}>
            {bucket.label && (
              <header className="mb-3 flex items-center justify-between gap-3 border-b border-border pb-2">
                <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
                  {group === "company" ? (
                    <CompanyLogo
                      name={bucket.label}
                      className="size-4"
                    />
                  ) : (
                    <CalendarDays
                      className="size-4 text-primary"
                      aria-hidden
                    />
                  )}
                  {bucket.label}
                </h3>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {bucket.items.length}{" "}
                  {bucket.items.length === 1 ? "session" : "sessions"}
                </span>
              </header>
            )}

            {view === "grid" ? (
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {bucket.items.map((s) => (
                  <li key={s.id}>
                    <SessionCard
                      session={s}
                      selection={
                        selectMode
                          ? {
                              selected: selectedIds.has(s.id),
                              onToggle: () => toggleOne(s.id),
                              disabled: pending,
                            }
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-background shadow-sm">
                {bucket.items.map((s) => (
                  <li key={s.id}>
                    <SessionRow
                      session={s}
                      selection={
                        selectMode
                          ? {
                              selected: selectedIds.has(s.id),
                              onToggle: () => toggleOne(s.id),
                              disabled: pending,
                            }
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
