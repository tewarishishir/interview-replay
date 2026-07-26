import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Plus } from "lucide-react";
import { LocalTime } from "@/components/ui/local-time";

import { auth } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listRebuilds } from "@/lib/rebuilds/queries";
import { toRebuildDto } from "@/lib/rebuilds/dto";
import { STORY_THEMES } from "@/lib/profiles/themes";
import type { StoryTheme } from "@/lib/db/schema";
import { DeleteRebuildButton } from "@/components/app/delete-rebuild-button";

export const metadata: Metadata = {
  title: "Practice rebuilds",
};

/**
 * Lifecycle dashboard for Practice Rebuilds.
 *
 * Lists every non-discarded rebuild the user has ever started, with
 * a status badge and a deep link back into the rebuild flow at
 * exactly the step they stopped at (resume semantics live in the
 * client component's `initialStepFor` helper). Hit from:
 *
 *   - the dashboard's "N rebuilds in progress" badge
 *   - the user menu (eventually)
 *   - direct navigation to /rebuilds/list
 *
 * The page is intentionally read-only here — `Start a new rebuild`
 * routes the user to the report view (which is where the
 * spec-mandated entry points live). We don't expose a
 * `/rebuilds/new` flow because rebuilds always need a question
 * text, and asking for one in isolation would let the user create
 * an empty rebuild they can't reasonably complete.
 */
export default async function RebuildsListPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/signin?callbackUrl=${encodeURIComponent("/rebuilds/list")}`);
  }

  const rebuilds = await listRebuilds({ userId: session.user.id, limit: 100 });
  const dtos = rebuilds.map(toRebuildDto);

  // Bucket them so the user sees the most actionable rows first:
  // "in progress" at top (these are the ones they should resume),
  // then "critiqued" (waiting for a save-to-bank decision), then
  // the historical "saved" rows.
  const inProgress = dtos.filter((r) => r.status === "in_progress");
  const critiqued = dtos.filter((r) => r.status === "critiqued");
  const saved = dtos.filter((r) => r.status === "saved_to_bank");

  return (
    <section className="mx-auto max-w-4xl px-6 py-10">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to dashboard
      </Link>

      <header className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Practice rebuilds
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Drafts you started by reworking an interview answer. InterviewReplay
            critiques what you wrote — it doesn&apos;t write the answer for
            you. Open a session report to start a new rebuild.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/dashboard">
            <Plus className="size-4" aria-hidden />
            Start from a session
          </Link>
        </Button>
      </header>

      <div className="mt-10 space-y-10">
        <ListSection title="In progress" rows={inProgress} />
        <ListSection title="Awaiting save" rows={critiqued} />
        <ListSection title="Saved to story bank" rows={saved} />

        {dtos.length === 0 && (
          <div className="rounded-xl border border-dashed border-border bg-muted/30 p-12 text-center">
            <h2 className="text-lg font-semibold">No rebuilds yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              When you finish an interview analysis, each improvement on the
              report has a &ldquo;Rebuild a story for this&rdquo; button.
              That&apos;s the way to start.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function ListSection({
  title,
  rows,
}: {
  title: string;
  rows: ReturnType<typeof toRebuildDto>[];
}) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {title} <span className="text-foreground/50">· {rows.length}</span>
      </h2>
      <ul className="mt-4 grid gap-3">
        {rows.map((r) => (
          <li key={r.id}>
            <RebuildRow rebuild={r} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RebuildRow({
  rebuild,
}: {
  rebuild: ReturnType<typeof toRebuildDto>;
}) {
  const themeLabel = rebuild.questionTheme
    ? (STORY_THEMES.find(
        (t) => t.value === (rebuild.questionTheme as StoryTheme),
      )?.label ?? rebuild.questionTheme)
    : null;
  const updated = formatRelative(rebuild.updatedAt);
  return (
    <div className="group relative rounded-xl border border-border bg-background transition-colors hover:bg-muted">
      <div className="flex items-start gap-4 p-5">
        {/* Main clickable area */}
        <Link
          href={`/rebuilds/${rebuild.id}`}
          className="min-w-0 flex-1"
        >
          <p className="line-clamp-2 text-base font-medium">
            {rebuild.headline?.trim() || rebuild.questionText}
          </p>
          <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
            {rebuild.questionText}
          </p>
        </Link>

        {/* Status + delete */}
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={rebuild.status} />
          <DeleteRebuildButton id={rebuild.id} />
        </div>
      </div>
      <div className="px-5 pb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {themeLabel && <Badge variant="outline">{themeLabel}</Badge>}
        <span>Updated {typeof updated === "string" ? updated : <LocalTime date={updated} options={{ year: "numeric", month: "short", day: "numeric" }} />}</span>
        {rebuild.critiqueRunCount > 0 && (
          <span>· {rebuild.critiqueRunCount} critique{rebuild.critiqueRunCount === 1 ? "" : "s"}</span>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ReturnType<typeof toRebuildDto>["status"] }) {
  switch (status) {
    case "in_progress":
      return <Badge variant="secondary">In progress</Badge>;
    case "critiqued":
      return (
        <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">
          Critiqued
        </Badge>
      );
    case "saved_to_bank":
      return (
        <Badge className="bg-emerald-100 text-emerald-900 hover:bg-emerald-100">
          Saved
        </Badge>
      );
    case "discarded":
      return <Badge variant="outline">Discarded</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function formatRelative(iso: string): string | Date {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t);
}
