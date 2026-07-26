import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, FileText, Layers } from "lucide-react";
import { z } from "zod";

import { reportSchema } from "@/lib/llm";
import { getAdminSessionBundle } from "@/lib/admin/sessions-queries";
import { effectiveWordCount } from "@/lib/sessions/effective-transcript";
import { OUTCOME_DISPLAY } from "@/lib/outcomes/colors";
import { ReportView } from "@/components/app/report-view";
import { LocalTime } from "@/components/ui/local-time";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Session detail · InterviewReplay admin",
};

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const formatDuration = (seconds: number): string => {
  if (seconds <= 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

export default async function AdminSessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { id } = parsed.data;

  const bundle = await getAdminSessionBundle(id);
  if (!bundle) notFound();

  const { session: row, transcript, artifacts, reports, outcome } = bundle;

  const reportRow = reports[0] ?? null;
  const previousReports = reports.slice(1);

  const parsedReport = reportRow
    ? reportSchema.safeParse(reportRow.reportJson)
    : null;

  const transcriptWordCount = transcript
    ? effectiveWordCount({
        wordCount: transcript.wordCount,
        editedText: transcript.editedText,
      })
    : 0;

  const outcomeDisplay = outcome
    ? OUTCOME_DISPLAY[outcome.outcomeType as keyof typeof OUTCOME_DISPLAY]
    : null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* Breadcrumb */}
      <div className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
        <Link href={`/admin/users/${bundle.ownerId}`} className="hover:underline">
          ← Back to {bundle.ownerDisplayName ?? bundle.ownerEmail}
        </Link>
      </div>

      {/* Header */}
      <header className="mt-4">
        <div className="flex items-center gap-2 flex-wrap">
          <div>
            <p
              className="text-sm font-medium"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {row.companyName}
            </p>
            <h1
              className="mt-0.5 text-2xl font-semibold"
              style={{ color: "var(--color-text-primary)" }}
            >
              {row.roleTitle}
            </h1>
            <p
              className="mt-1 text-sm"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {capitalize(row.level)} · {labelForRound(row.roundType)} round
            </p>
          </div>
          <span
            className="ml-auto rounded-full border px-3 py-1 text-xs font-medium"
            style={{
              borderColor: "var(--color-border-secondary)",
              background: "var(--color-bg-secondary)",
              color:
                row.state === "complete"
                  ? "var(--color-success-text)"
                  : row.state === "failed"
                    ? "var(--color-danger-text)"
                    : "var(--color-text-tertiary)",
            }}
          >
            {row.state.replace(/_/g, " ")}
          </span>
        </div>

        {/* User attribution */}
        <div
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs"
          style={{
            borderColor: "var(--color-border-tertiary)",
            background: "var(--color-bg-secondary)",
            color: "var(--color-text-secondary)",
          }}
        >
          <span style={{ color: "var(--color-text-tertiary)" }}>User:</span>
          <Link
            href={`/admin/users/${bundle.ownerId}`}
            className="hover:underline font-medium"
            style={{ color: "var(--color-text-primary)" }}
          >
            {bundle.ownerDisplayName
              ? `${bundle.ownerDisplayName} (${bundle.ownerEmail})`
              : bundle.ownerEmail}
          </Link>
        </div>
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_260px]">
        {/* Main content */}
        <main className="space-y-6">
          {/* Report */}
          {row.state === "analyzing" ? (
            <AdminInfoPanel>Analysis in progress — no report yet.</AdminInfoPanel>
          ) : row.state === "failed" ? (
            <AdminInfoPanel>Analysis failed. No report generated.</AdminInfoPanel>
          ) : reportRow == null ? (
            <AdminInfoPanel>No report for this session.</AdminInfoPanel>
          ) : parsedReport && parsedReport.success ? (
            <ReportView
              report={parsedReport.data}
              roundType={row.roundType}
              isHistorical={true}
              transcript={
                transcript
                  ? {
                      wordCount: transcriptWordCount,
                      durationSeconds: transcript.durationSeconds,
                    }
                  : null
              }
              reportCreatedAt={reportRow.createdAt}
            />
          ) : (
            <LegacyReportPanel raw={reportRow.reportJson} />
          )}

          {/* Transcript text (admin inline view) */}
          {transcript && (
            <AdminCard title="Transcript">
              {transcript.editedText ? (
                <div>
                  <p
                    className="mb-2 text-xs"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Showing edited text
                  </p>
                  <pre
                    className="whitespace-pre-wrap text-sm leading-relaxed"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    {transcript.editedText}
                  </pre>
                </div>
              ) : transcript.redactedText ? (
                <div>
                  <p
                    className="mb-2 text-xs"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Showing redacted transcript ({transcript.redactionCount ?? 0}{" "}
                    redactions)
                  </p>
                  <pre
                    className="whitespace-pre-wrap text-sm leading-relaxed"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    {transcript.redactedText}
                  </pre>
                </div>
              ) : (
                <p
                  className="text-sm italic"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Transcript text not available.
                </p>
              )}
            </AdminCard>
          )}
        </main>

        {/* Sidebar */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <AdminCard title="Session">
            <dl className="space-y-2 text-sm">
              {transcript && (
                <>
                  <SidebarRow
                    icon={<Clock className="size-3.5" aria-hidden />}
                    label="Duration"
                    value={formatDuration(transcript.durationSeconds)}
                  />
                  <SidebarRow
                    icon={<FileText className="size-3.5" aria-hidden />}
                    label="Words"
                    value={transcriptWordCount.toLocaleString()}
                  />
                </>
              )}
              <SidebarRow
                icon={<Layers className="size-3.5" aria-hidden />}
                label="Artifacts"
                value={String(artifacts.length)}
              />
              <SidebarRow
                label="Created"
                value={null}
                dateValue={row.createdAt}
              />
              {reportRow && (
                <SidebarRow
                  label="Report generated"
                  value={null}
                  dateValue={reportRow.createdAt}
                />
              )}
              {reportRow?.modelVersion && (
                <SidebarRow
                  label="Model"
                  value={reportRow.modelVersion}
                  mono
                />
              )}
            </dl>
          </AdminCard>

          {/* Outcome */}
          {outcome && (
            <AdminCard title="Outcome">
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  {outcomeDisplay && (
                    <span
                      aria-hidden="true"
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: outcomeDisplay.dotColor }}
                    />
                  )}
                  <span
                    className="font-medium"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    {outcomeDisplay?.label ?? outcome.outcomeType}
                  </span>
                </div>
                {outcome.outcomeReceivedAt && (
                  <p
                    className="text-xs"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Heard back:{" "}
                    <LocalTime
                      date={outcome.outcomeReceivedAt}
                      options={{ year: "numeric", month: "short", day: "numeric" }}
                    />
                  </p>
                )}
                {outcome.nextRoundType && (
                  <p
                    className="text-xs"
                    style={{ color: "var(--color-text-secondary)" }}
                  >
                    Next round: {outcome.nextRoundType}
                  </p>
                )}
              </div>
            </AdminCard>
          )}

          {/* Previous reports */}
          {previousReports.length > 0 && (
            <AdminCard title="Previous analyses">
              <ul className="space-y-1.5 text-sm">
                {previousReports.map((r) => (
                  <li key={r.id}>
                    <span style={{ color: "var(--color-text-tertiary)" }}>
                      <LocalTime date={r.createdAt} /> — {r.modelVersion ?? "unknown model"}
                    </span>
                  </li>
                ))}
              </ul>
            </AdminCard>
          )}

          {/* Raw session id for debugging */}
          <AdminCard title="Debug">
            <dl className="space-y-1 text-xs" style={{ color: "var(--color-text-tertiary)" }}>
              <div>
                <dt className="uppercase tracking-wide">Session ID</dt>
                <dd className="mt-0.5 break-all font-mono">{row.id}</dd>
              </div>
              <div className="mt-2">
                <dt className="uppercase tracking-wide">User ID</dt>
                <dd className="mt-0.5 break-all font-mono">{bundle.ownerId}</dd>
              </div>
            </dl>
          </AdminCard>
        </aside>
      </div>
    </div>
  );
}

function AdminCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-md border p-4"
      style={{
        background: "var(--color-bg-primary)",
        borderColor: "var(--color-border-tertiary)",
      }}
    >
      <h2
        className="text-xs font-semibold uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function AdminInfoPanel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-md border p-8 text-center text-sm"
      style={{
        borderColor: "var(--color-border-tertiary)",
        color: "var(--color-text-tertiary)",
      }}
    >
      {children}
    </div>
  );
}

function SidebarRow({
  icon = null,
  label,
  value,
  dateValue,
  mono = false,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string | null;
  dateValue?: Date;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt
        className="flex items-center gap-1.5 text-xs uppercase tracking-wider"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {icon}
        {label}
      </dt>
      <dd
        className={`whitespace-nowrap text-sm font-medium ${mono ? "font-mono text-xs" : ""}`}
        style={{ color: "var(--color-text-primary)" }}
      >
        {dateValue ? (
          <LocalTime
            date={dateValue}
            options={{ year: "numeric", month: "short", day: "numeric" }}
          />
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function LegacyReportPanel({ raw }: { raw: unknown }) {
  return (
    <div
      className="rounded-xl border p-6"
      style={{
        borderColor: "var(--color-warning-border)",
        background: "var(--color-warning-bg)",
      }}
    >
      <h2
        className="text-lg font-semibold"
        style={{ color: "var(--color-text-primary)" }}
      >
        Older report format
      </h2>
      <p className="mt-2 text-sm" style={{ color: "var(--color-text-secondary)" }}>
        This report was generated before the latest schema.
      </p>
      <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-background p-3 text-xs">
        {JSON.stringify(raw, null, 2)}
      </pre>
    </div>
  );
}

function labelForRound(t: string): string {
  switch (t) {
    case "coding":
      return "Coding";
    case "system_design":
      return "System design";
    case "behavioral":
      return "Behavioral";
    case "other":
      return "Other";
    default:
      return t;
  }
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
