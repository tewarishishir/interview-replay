"use client";

import { IconInfoCircle } from "@tabler/icons-react";

interface SampleReportBannerProps {
  /** `/signup` in production, `/signin` on invite-only staging. Resolved server-side. */
  signupHref: string;
}

export function SampleReportBanner({ signupHref }: SampleReportBannerProps) {
  return (
    <div
      className="sticky top-16 z-10 border-b border-border"
      style={{
        background: "var(--color-bg-secondary)",
        borderBottom: "2px solid var(--color-ir-gold)",
      }}
    >
      <div
        className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-3.5 sm:flex-row sm:items-center sm:gap-4"
        style={{ padding: "14px 24px" }}
      >
        <div className="flex flex-1 items-start gap-2.5">
          <IconInfoCircle
            size={16}
            className="mt-0.5 shrink-0"
            style={{ color: "var(--color-ir-gold)" }}
            aria-hidden
          />
          <p className="text-sm leading-snug text-foreground/80">
            <strong className="font-semibold text-foreground">
              This is a sample report.
            </strong>{" "}
            <span>
              Generated from a real InterviewReplay beta session. Your reports will
              look like this — analyzing your actual interview, your actual
              answers.
            </span>
          </p>
        </div>
        <a
          href={signupHref}
          className="shrink-0 text-sm font-medium whitespace-nowrap hover:underline"
          style={{ color: "var(--color-ir-gold)" }}
        >
          Try it yourself →
        </a>
      </div>
    </div>
  );
}
