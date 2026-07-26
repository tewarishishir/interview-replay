import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { and, eq, lt, sql } from "drizzle-orm";
import { BookOpen, Mic, Plus, Wrench } from "lucide-react";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { listUserSessions } from "@/lib/queries/sessions";
import {
  buildReferralLink,
  ensureReferralCodeForUser,
  getReferralStats,
} from "@/lib/referrals";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DashboardSessionsList } from "@/components/app/dashboard-sessions-list";
import { InviteNudge } from "@/components/app/invite-nudge";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  // The (app) layout already redirects unauthenticated traffic, but
  // page-level reads still need to narrow the optional `user` so
  // `userId` is `string` rather than `string | undefined`.
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/signin");
  }

  const userId = session.user.id;

  // Five parallel reads for the dashboard. Story-bank and
  // stale-rebuild counts are cheap (`count(*)` over indexed
  // columns) and the badges are noisy without them — so we eat the
  // two extra round-trips rather than ship a flicker. The referral
  // queries are folded into the SAME parallel block so the dashboard
  // doesn't pay for two sequential round-trip groups.
  const staleCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [
    sessions,
    storyCountRow,
    staleRebuildCountRow,
    referralCode,
    referralStats,
  ] = await Promise.all([
    listUserSessions(userId),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.stories)
      .where(eq(schema.stories.userId, userId))
      .then((rows) => rows[0]),
    // "Stale in-progress" matches the spec: only nudge the user
    // about rebuilds they actually abandoned (>24h since last
    // edit). A rebuild they're actively typing into shouldn't
    // show up as a chore on the dashboard.
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
    // Referral link + stats for the dismissible "Invite friends"
    // nudge. We compose the link server-side so the SSR'd HTML
    // carries the real URL — copy-to-clipboard works on first
    // paint without waiting on a post-mount fetch.
    ensureReferralCodeForUser(userId),
    getReferralStats(userId),
  ]);

  const storyCount = storyCountRow?.n ?? 0;
  const staleRebuildCount = staleRebuildCountRow?.n ?? 0;

  const requestHeaders = await headers();
  const proto = requestHeaders.get("x-forwarded-proto") ?? "https";
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    null;
  const referralLink = buildReferralLink({
    code: referralCode,
    origin: host ? `${proto}://${host}` : null,
  });

  // Free-trial nudge surfaces on first dashboard render when the user
  // hasn't yet created a session — the spec wants them to see the "2
  // free credits" framing the first time they land, and have it
  // disappear once they engage. A session that's later soft-deleted
  // brings the nudge back automatically (sessions.length === 0 again).
  const [trialUserRow] = await db
    .select({ creditBalance: schema.users.creditBalance })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const showFreeTrialNudge =
    sessions.length === 0 && (trialUserRow?.creditBalance ?? 0) > 0;

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

      {showFreeTrialNudge && (
        <div className="mt-6 rounded-xl border border-primary/30 bg-primary/5 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
            <div>
              <h2 className="text-base font-semibold">
                Your {trialUserRow?.creditBalance ?? 2} free credits are ready
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Use them to analyze your first real interview. One 60-minute
                interview, or two 30-minute rounds &mdash; your choice.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="primary">
                <Link href="/sessions/new">
                  <Plus className="size-4" aria-hidden />
                  Start a new session
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/#how-it-works">How does InterviewReplay work?</Link>
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-6">
        <InviteNudge
          link={referralLink}
          creditsEarned={referralStats.creditsEarned}
        />
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
