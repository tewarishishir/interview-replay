"use client";

interface SampleReportBottomCtaProps {
  /** `/signup` in production, `/signin` on invite-only staging. Resolved server-side. */
  signupHref: string;
}

export function SampleReportBottomCta({ signupHref }: SampleReportBottomCtaProps) {
  return (
    <section
      aria-labelledby="sample-cta-heading"
      style={{ background: "var(--color-bg-secondary)" }}
      className="border-t border-border"
    >
      <div className="mx-auto flex max-w-2xl flex-col items-center px-6 py-20 text-center">
        <h2
          id="sample-cta-heading"
          className="text-3xl font-semibold tracking-tight sm:text-4xl"
        >
          This was a real InterviewReplay report.
        </h2>
        <p className="mt-6 text-base leading-relaxed text-muted-foreground">
          The candidate above used InterviewReplay after a Meta Senior Software Engineer
          coding round. They advanced to the next round. Their full report — the
          same depth you just read — was generated automatically from their
          interview recording.
        </p>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          See what InterviewReplay tells you about your next real interview.
        </p>
        <a
          href={signupHref}
          className="mt-8 inline-flex h-11 items-center justify-center rounded-md px-8 text-sm font-semibold text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ background: "var(--color-ir-navy)" }}
        >
          Start your first analysis
        </a>
        <p className="mt-4 text-xs text-muted-foreground">
          Free and open source under the MIT license.
        </p>
      </div>
    </section>
  );
}
