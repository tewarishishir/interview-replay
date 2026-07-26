import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { and, eq, lt, sql } from "drizzle-orm";
import { BookOpen, Mic, Plus, Wrench } from "lucide-react";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { listUserSessions } from "@/lib/queries/sessions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DashboardSessionsList } from "@/components/app/dashboard-sessions-list";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/signin");
  }

  const userId = session.user.id;

  const staleCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [sessions, storyCountRow, staleRebuildCountRow] = await Promise.all([
    listUserSessions(userId),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.stories)
      .where(eq(schema.stories.userId, userId))
      .then((rows) => rows[0]),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.storyRebuilds)
      .where(
        and(
          eq(schema.storyRebuilds.userId, userId),
          eq(schema.storyRebuilds.status, "in_progress"),
          lt(schema.storyRebuilds.updatedAt, staleCutoff),
        ),
      )
      .then((rows) => rows[0]),
  ]);

  const storyCount = storyCountRow?.n ?? 0;
  const staleRebuildCount = staleRebuildCountRow?.n ?? 0;

  return (
    <section className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your interview history and feedback, all in one place.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge asChild variant="outline">
              <Link
                href="/stories"
                className="inline-flex items-center gap-1"
              >
                <BookOpen className="size-3" aria-hidden />
                Story bank: {storyCount}{" "}
                {storyCount === 1 ? "story" : "stories"}
              </Link>
            </Badge>
            {staleRebuildCount > 0 && (
              <Badge
                asChild
                className="bg-amber-100 text-amber-900 hover:bg-amber-100"
              >
                <Link
                  href="/rebuilds/list"
                  className="inline-flex items-center gap-1"
                >
                  <Wrench className="size-3" aria-hidden />
                  {staleRebuildCount} rebuild
                  {staleRebuildCount === 1 ? "" : "s"} in progress
                </Link>
              </Badge>
            )}
          </div>
        </div>
        <Button asChild variant="primary">
          <Link href="/sessions/new">
            <Plus className="size-4" aria-hidden />
            Start a new session
          </Link>
        </Button>
      </div>

      <div className="mt-10">
        {sessions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/30 p-12 text-center">
            <Mic
              className="mx-auto size-8 text-muted-foreground"
              aria-hidden
            />
            <h2 className="mt-4 text-lg font-semibold">
              You haven&apos;t analyzed any interviews yet
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Click &ldquo;Start a new session&rdquo; to begin. We&apos;ll
              walk you through the setup, then capture only your microphone
              when you&apos;re ready to record.
            </p>
            <Button asChild variant="primary" className="mt-6">
              <Link href="/sessions/new">
                <Plus className="size-4" aria-hidden />
                Start a new session
              </Link>
            </Button>
          </div>
        ) : (
          <DashboardSessionsList sessions={sessions} />
        )}
      </div>
    </section>
  );
}
