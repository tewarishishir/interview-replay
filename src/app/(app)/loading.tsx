/**
 * Skeleton shown while an authenticated route's RSC resolves. Kept
 * generic enough to fit the dashboard, sessions list, account, and
 * credits pages without looking out of place on any of them.
 */
export default function AppLoading() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="mx-auto max-w-5xl space-y-6 px-6 py-10"
    >
      <div className="space-y-2">
        <div className="h-7 w-48 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-72 animate-pulse rounded-md bg-muted/70" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-28 animate-pulse rounded-lg border border-border bg-muted/40"
          />
        ))}
      </div>
      <div className="space-y-2">
        <div className="h-12 animate-pulse rounded-md bg-muted/40" />
        <div className="h-12 animate-pulse rounded-md bg-muted/40" />
        <div className="h-12 animate-pulse rounded-md bg-muted/40" />
      </div>
    </div>
  );
}
