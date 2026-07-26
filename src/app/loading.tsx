/**
 * Default streaming fallback shown while a sibling segment's RSC
 * fetches data. Renders a neutral skeleton so the page paints
 * instantly even on a cold Neon connection.
 *
 * Per-segment loading.tsx files (e.g. inside `(app)` or `(admin)`)
 * can override this with a layout-aware skeleton. This file is the
 * fallback for everything below the root layout that doesn't supply
 * one of its own.
 */
export default function Loading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center px-6 py-16">
      <div
        role="status"
        aria-label="Loading"
        className="flex items-center gap-3 text-muted-foreground"
      >
        <span className="size-2 animate-pulse rounded-full bg-current" />
        <span className="size-2 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
        <span className="size-2 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
      </div>
    </div>
  );
}
