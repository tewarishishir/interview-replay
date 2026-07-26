import type { Metadata } from "next";

import { ReportView } from "@/components/app/report-view";
import { SampleReportBanner } from "@/components/marketing/SampleReportBanner";
import { SampleReportBottomCta } from "@/components/marketing/SampleReportBottomCta";
import { features } from "@/lib/env";
import {
  SAMPLE_REPORT,
  SAMPLE_ROUND_TYPE,
  SAMPLE_TRANSCRIPT,
} from "@/lib/sample-data/sample-report";

const BASE_URL = "https://localhost:3000";

export const metadata: Metadata = {
  title: "See a Sample InterviewReplay Report | Honest Interview Feedback",
  description:
    "This is a real InterviewReplay report from a beta session — anonymized with permission. See exactly what kind of feedback InterviewReplay produces from a real interview.",
  alternates: {
    canonical: `${BASE_URL}/sample-report`,
  },
  openGraph: {
    title: "See a real InterviewReplay report",
    description:
      "This is what honest interview feedback actually looks like. Specific quotes, specific gaps, specific things to fix.",
    url: `${BASE_URL}/sample-report`,
    siteName: "InterviewReplay",
    images: [
      {
        url: `${BASE_URL}/og-image.png`,
        width: 1200,
        height: 630,
        alt: "Sample InterviewReplay Report — Meta Senior Software Engineer, Coding round",
      },
    ],
    locale: "en_IN",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "See a real InterviewReplay report",
    description: "This is what honest interview feedback actually looks like.",
    images: [`${BASE_URL}/og-image.png`],
  },
};

export default function SampleReportPage() {
  const signupHref = features.inviteOnlyBeta ? "/signin" : "/signup";

  return (
    <>
      <SampleReportBanner signupHref={signupHref} />

      <div className="mx-auto max-w-5xl px-6 py-10">
        {/* Context header — company / role / round so visitors know what they're reading */}
        <div className="mb-8 flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Sample report
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Meta — Senior Software Engineer
          </h1>
          <p className="text-sm text-muted-foreground">
            Coding round · 45 minutes
          </p>
        </div>

        <ReportView
          report={SAMPLE_REPORT}
          roundType={SAMPLE_ROUND_TYPE}
          isSampleMode={true}
          transcript={SAMPLE_TRANSCRIPT}
        />
      </div>

      <SampleReportBottomCta signupHref={signupHref} />
    </>
  );
}
