import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { LocalTime } from "@/components/ui/local-time";

import { auth } from "@/lib/auth";
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  describeDeletionState,
} from "@/lib/compliance";
import { db, schema } from "@/lib/db";
import {
  AccountDeletionSection,
  AccountRestoreBanner,
} from "@/components/app/account-section";
import { ThemeSection } from "@/components/app/theme-section";

export const metadata: Metadata = {
  title: "Account",
};

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/signin?callbackUrl=/account");
  }
  const userId = session.user.id;

  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      createdAt: schema.users.createdAt,
      deletedAt: schema.users.deletedAt,
      deletionRequestedAt: schema.users.deletionRequestedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!user) {
    redirect("/signin?callbackUrl=/account");
  }

  const deletionState = describeDeletionState({
    deletedAt: user.deletedAt,
    deletionRequestedAt: user.deletionRequestedAt,
  });

  return (
    <section className="mx-auto max-w-3xl px-6 py-12">
      <header className="border-b border-border pb-6">
        <h1 className="text-3xl font-semibold tracking-tight">Account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Profile and account settings.
        </p>
      </header>

      {deletionState.pending && deletionState.hardDeleteAt && (
        <div className="mt-6">
          <AccountRestoreBanner
            hardDeleteAtIso={deletionState.hardDeleteAt.toISOString()}
            graceDays={ACCOUNT_DELETION_GRACE_DAYS}
          />
        </div>
      )}

      <div className="mt-8 space-y-6">
        <Card heading="Profile">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <Field label="Email" value={user.email} />
            <Field
              label="Display name"
              value={user.name ?? <em className="not-italic text-muted-foreground">not set</em>}
            />
            <Field
              label="Joined"
              value={<LocalTime date={user.createdAt} options={{ year: "numeric", month: "long", day: "numeric" }} />}
            />
          </dl>
        </Card>

        <Card heading="Appearance">
          <ThemeSection />
        </Card>

        <Card heading="Delete my account" tone="destructive">
          {deletionState.pending ? (
            <p className="text-sm text-muted-foreground">
              Your account is scheduled for deletion. See the banner
              above to cancel, or do nothing and we&apos;ll permanently
              delete everything on the date shown.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                We&apos;ll start a {ACCOUNT_DELETION_GRACE_DAYS}-day grace
                period. During that window, signing back in cancels the
                deletion. After it expires, we permanently delete your
                profile, sessions, transcripts, artifacts, and reports.
              </p>
              <div className="mt-4">
                <AccountDeletionSection
                  graceDays={ACCOUNT_DELETION_GRACE_DAYS}
                  userEmail={user.email}
                />
              </div>
            </>
          )}
        </Card>
      </div>
    </section>
  );
}

function Card({
  heading,
  children,
  tone,
}: {
  heading: string;
  children: React.ReactNode;
  tone?: "destructive";
}) {
  const border =
    tone === "destructive"
      ? "border-destructive/40"
      : "border-border";
  return (
    <section
      className={`rounded-xl border bg-background p-6 ${border}`}
    >
      <h2
        className={`text-lg font-semibold ${
          tone === "destructive" ? "text-destructive" : "text-foreground"
        }`}
      >
        {heading}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-foreground">{value}</dd>
    </div>
  );
}
