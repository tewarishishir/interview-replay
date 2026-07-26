"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { RotateCw } from "lucide-react";

interface RefreshButtonProps {
  /** ISO timestamp the server-rendered snapshot was computed at. */
  generatedAt: string;
}

/**
 * Header refresh button. Uses `router.refresh()` to force the
 * (admin)/ops server component to re-render with fresh data
 * (Next 15's recommended pattern for re-fetching server-only
 * data without losing client state).
 *
 * The label updates every 15s so the "Refreshed N s ago" stays
 * honest without the rest of the page polling. The interval is
 * cleared on unmount.
 *
 * We deliberately don't hit `/api/admin/ops` directly here — the
 * route exists for external/scripted consumers (and to validate
 * the cache-control header), but the in-page refresh path is the
 * router.refresh() flow because it keeps the rendering pipeline
 * unified and respects the layout's audit-log write.
 */
export function RefreshButton({ generatedAt }: RefreshButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const generated = new Date(generatedAt).getTime();
  const label = formatRelative(now - generated);

  return (
    <div className="flex items-center gap-3">
      <span
        className="text-xs"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Refreshed {label}
      </span>
      <button
        type="button"
        disabled={isPending}
        onClick={() => startTransition(() => router.refresh())}
        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50"
        style={{
          borderColor: "var(--color-border-secondary)",
          background: "var(--color-bg-primary)",
          color: "var(--color-text-secondary)",
        }}
      >
        <RotateCw
          className="size-3"
          aria-hidden
          style={{
            animation: isPending ? "spin 1s linear infinite" : undefined,
          }}
        />
        {isPending ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

function formatRelative(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "just now";
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 30) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
