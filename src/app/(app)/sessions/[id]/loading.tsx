/**
 * Suspense boundary for the session detail page.
 *
 * Shown while the server component fetches session data from the DB.
 * Matches the two-column layout (main report area + sidebar) so the
 * shell doesn't shift when the real content streams in.
 *
 * The layout's header (app nav) renders immediately; this skeleton
 * covers only the page segment below it.
 */
export default function SessionLoading() {
  return (
    <section
      className="mx-auto max-w-6xl px-6 py-12"
      role="status"
      aria-label="Loading session"
    >
      {/* Back link */}
      <div className="h-4 w-28 animate-pulse rounded bg-muted/60" />

      {/* Header block */}
      <header className="mt-6 space-y-2">
        <div className="h-4 w-32 animate-pulse rounded bg-muted/60" />
        <div className="flex items-baseline justify-between gap-3">
          <div className="h-7 w-64 animate-pulse rounded bg-muted" />
          <div className="h-6 w-20 animate-pulse rounded-full bg-muted/60" />
        </div>
        <div className="h-4 w-40 animate-pulse rounded bg-muted/50" />
      </header>

      {/* Two-column body */}
      <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_280px]">
        {/* Main report area */}
        <main className="space-y-4">
          <div className="h-8 w-48 animate-pulse rounded bg-muted/70" />
          <div className="space-y-3">
            {[100, 90, 95, 85, 92].map((w, i) => (
              <div
                key={i}
                className="animate-pulse rounded bg-muted/40"
                style={{ height: "1rem", width: `${w}%` }}
              />
            ))}
          </div>
          <div className="mt-6 space-y-3">
            {[88, 94, 80].map((w, i) => (
              <div
                key={i}
                className="animate-pulse rounded bg-muted/40"
                style={{ height: "1rem", width: `${w}%` }}
              />
            ))}
          </div>
          {/* Simulated section card */}
          <div className="mt-8 h-48 animate-pulse rounded-xl border border-border bg-muted/30" />
          <div className="h-48 animate-pulse rounded-xl border border-border bg-muted/30" />
        </main>

        {/* Sidebar */}
        <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-xl border border-border p-5 space-y-3">
            <div className="h-3 w-16 animate-pulse rounded bg-muted/60" />
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex justify-between"
              >
                <div className="h-3 w-16 animate-pulse rounded bg-muted/50" />
                <div className="h-3 w-12 animate-pulse rounded bg-muted/50" />
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-border p-5 space-y-3">
            <div className="h-3 w-12 animate-pulse rounded bg-muted/60" />
            <div className="h-3 w-28 animate-pulse rounded bg-muted/40" />
            <div className="h-7 w-full animate-pulse rounded bg-muted/40" />
          </div>
        </aside>
      </div>
    </section>
  );
}
