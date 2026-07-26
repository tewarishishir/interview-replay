import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/ui/local-time";

import { getAdminUser } from "@/lib/admin/auth";
import {
  type UserDetail,
  getUserDetail,
} from "@/lib/admin/users-queries";
import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { OUTCOME_DISPLAY, type OutcomeType } from "@/lib/outcomes/colors";
import { NotesPanel } from "@/components/admin/users/notes-panel";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "User detail · InterviewReplay admin",
};

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = await getAdminUser();
  const detail = await getUserDetail(id);
  if (!detail) notFound();

  if (admin) {
    trackServerEvent({
      distinctId: admin.id,
      event: ANALYTICS_EVENTS.adminUserViewed,
      properties: { target_user_id: id },
    });
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <BreadcrumbBack />
      <ProfileHeader user={detail} />

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2 flex flex-col gap-6">
          <SessionsCard sessions={detail.sessions} />
        </section>

        <aside className="flex flex-col gap-6">
          <Card title="Notes">
            <NotesPanel userId={detail.id} notes={detail.notes} />
          </Card>
        </aside>
      </div>
    </div>
  );
}

function BreadcrumbBack() {
  return (
    <div className="text-xs">
      <Link
        href="/admin/users"
        className="hover:underline"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        ← Back to users
      </Link>
    </div>
  );
}

function ProfileHeader({ user }: { user: UserDetail }) {
  const geo = formatGeo(user.signupCountryCode, user.signupSubdivisionCode);
  return (
    <header className="mt-2">
      <h1
        className="text-2xl font-semibold"
        style={{ color: "var(--color-text-primary)" }}
      >
        {user.displayName?.trim() || user.email}
      </h1>
      <p
        className="mt-1 text-sm"
        style={{ color: "var(--color-text-secondary)" }}
      >
        {user.email} · joined <LocalTime date={user.signedUpAt} options={{ year: "numeric", month: "short", day: "numeric" }} /> · {geo}
      </p>

      <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Sessions (lifetime)"
          value={user.lifetime.sessionsCount.toLocaleString()}
        />
      </dl>

      <div
        className="mt-4 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        <span>Theme: {user.themePreference}</span>
        <span>
          Profile completeness:{" "}
          {user.profile
            ? `${[user.profile.hasResume, user.profile.projectsCount > 0, user.profile.storiesCount > 0, user.profile.targetLevels.length > 0].filter(Boolean).length}/4`
            : "0/4 (no profile row)"}
        </span>
        <span>
          Last activity: <LocalTime date={user.lastActivityAt} />
        </span>
        <span>User id: {user.id}</span>
      </div>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="text-xs uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-xl font-semibold tabular-nums"
        style={{ color: "var(--color-text-primary)" }}
      >
        {value}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded-md border p-4"
      style={{
        background: "var(--color-bg-primary)",
        borderColor: "var(--color-border-tertiary)",
      }}
    >
      <h2
        className="text-sm font-semibold uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function SessionsCard({ sessions }: { sessions: UserDetail["sessions"] }) {
  return (
    <Card title={`Recent sessions (${sessions.length})`}>
      {sessions.length === 0 ? (
        <p
          className="text-sm italic"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          No sessions yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-baseline justify-between gap-2 border-b py-1.5 last:border-b-0"
              style={{ borderColor: "var(--color-border-tertiary)" }}
            >
              <Link
                href={`/admin/sessions/${s.id}`}
                className="font-medium hover:underline"
                style={{ color: "var(--color-text-primary)" }}
              >
                {s.companyName} · {s.roleTitle}
              </Link>
              <span
                className="text-xs"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {s.level} · {s.roundType.replace("_", " ")} ·{" "}
                <SessionStateBadge state={s.state} /> ·{" "}
                {s.outcomeType ? (
                  <OutcomeBadge outcomeType={s.outcomeType as OutcomeType} />
                ) : (
                  "no outcome"
                )}{" "}
                · <LocalTime date={s.createdAt} options={{ year: "numeric", month: "short", day: "numeric" }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SessionStateBadge({ state }: { state: string }) {
  const color = (() => {
    switch (state) {
      case "complete":
        return "var(--color-success-text)";
      case "failed":
        return "var(--color-danger-text)";
      case "interview_in_progress":
      case "analysis_in_progress":
        return "var(--color-warning-text)";
      default:
        return "var(--color-text-tertiary)";
    }
  })();
  return <span style={{ color }}>{state.replace(/_/g, " ")}</span>;
}

function OutcomeBadge({ outcomeType }: { outcomeType: OutcomeType }) {
  const display = OUTCOME_DISPLAY[outcomeType];
  if (!display) return <span>{outcomeType}</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "7px",
          height: "7px",
          borderRadius: "50%",
          backgroundColor: display.dotColor,
          flexShrink: 0,
        }}
      />
      {display.label}
    </span>
  );
}

function formatGeo(country: string | null, subdivision: string | null): string {
  if (!country) return "Unknown location";
  if (subdivision) return `${subdivision}, ${country}`;
  return country;
}
