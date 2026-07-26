import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Headphones, ListChecks, Settings2 } from "lucide-react";

import { auth } from "@/lib/auth";
import { features } from "@/lib/env";
import { Button } from "@/components/ui/button";
import {
  Testimonials,
  getTestimonialsReviewSchema,
} from "@/components/marketing/testimonials";

export const metadata: Metadata = {
  title: "InterviewReplay — Open-Source AI Interview Coaching",
  description:
    "Record your voice during real interviews. Get structured AI feedback on every answer — clarity, structure, filler words, STAR completeness. Free and open source.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "InterviewReplay — Open-Source AI Interview Coaching",
    description:
      "Record your real interview voice. Get structured AI coaching calibrated to the level you're targeting. Free and open source.",
    url: "/",
    images: [
      {
        url: "https://localhost:3000/og-image.png",
        width: 1200,
        height: 630,
        alt: "InterviewReplay — Real interviews. Honest feedback.",
      },
    ],
  },
};

const steps = [
  {
    icon: Settings2,
    title: "Set up your interview",
    description:
      "Tell us the company (Google, Meta, Amazon, Flipkart, a global remote role — anything), the level you're targeting (SDE-2, senior, staff, EM), and the round type — coding, system design, behavioral, or other.",
  },
  {
    icon: Headphones,
    title: "Record your voice",
    description:
      "InterviewReplay captures only your microphone (with headphones in, not the interviewer's audio). Start it before you join the call, stop it when you leave.",
  },
  {
    icon: ListChecks,
    title: "Get structured feedback",
    description:
      "A detailed AI analysis: what went well, what to improve, and how your answers compared to the bar for the level you targeted.",
  },
] as const;

const BASE_URL = "https://localhost:3000";

const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "InterviewReplay",
  url: BASE_URL,
  logo: `${BASE_URL}/favicon-512.png`,
  image: `${BASE_URL}/og-image.png`,
  description:
    "InterviewReplay provides AI-powered interview feedback for professionals, analyzing real interview recordings to deliver structured, actionable coaching calibrated to the candidate's target level.",
};

const softwareApplicationSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "InterviewReplay",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  url: BASE_URL,
  image: `${BASE_URL}/og-image.png`,
  description:
    "AI interview feedback tool for professionals. Records your microphone during real interviews and delivers structured analysis — clarity, STAR completeness, filler words, level-calibrated scoring — for FAANG, SDE-2, senior, staff, EM, and PM rounds.",
  inLanguage: "en",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    description: "Free and open source under the MIT license",
  },
};

export default async function HomePage() {
  const session = await auth();
  const isSignedIn = Boolean(session?.user?.id);

  const reviewSchema = await getTestimonialsReviewSchema();

  return (
    <>
      <section className="mx-auto max-w-6xl px-6 py-24 sm:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
            Real interview feedback. Personalized to you.
          </h1>
          <p className="mt-6 text-pretty text-lg leading-relaxed text-muted-foreground sm:text-xl">
            InterviewReplay records your voice during real interviews, then gives you
            structured AI feedback calibrated to your background, your
            projects, and the level you&apos;re targeting. Honest coaching,
            from what really happened.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {isSignedIn ? (
              <Button asChild size="lg" variant="primary">
                <Link href="/dashboard">
                  Go to your dashboard
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
            ) : features.inviteOnlyBeta ? (
              <Button asChild size="lg" variant="primary">
                <Link href="/signin">
                  Sign in
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
            ) : (
              <Button asChild size="lg" variant="primary">
                <Link href="/signup">
                  Get started
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
            )}
          </div>
          {!isSignedIn && !features.inviteOnlyBeta && (
            <p className="mt-4 text-xs text-muted-foreground">
              Free and open source under the MIT license.
            </p>
          )}
          {!isSignedIn && features.inviteOnlyBeta && (
            <p className="mt-4 text-xs text-muted-foreground">
              InterviewReplay is currently in closed beta. Sign in with your invited
              account to get started.
            </p>
          )}
        </div>
      </section>

      <section
        id="how-it-works"
        aria-labelledby="how-it-works-heading"
        className="border-t border-border bg-muted/30"
      >
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2
              id="how-it-works-heading"
              className="text-3xl font-semibold tracking-tight sm:text-4xl"
            >
              How it works
            </h2>
            <p className="mt-3 text-base text-muted-foreground">
              Three steps from &ldquo;I have an interview tomorrow&rdquo; to a
              written breakdown of how it went.
            </p>
          </div>

          <ol className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {steps.map((step, index) => (
              <li
                key={step.title}
                className="rounded-xl border border-border bg-background p-6"
              >
                <div className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                    {index + 1}
                  </span>
                  <step.icon
                    className="size-5 text-foreground"
                    aria-hidden
                  />
                </div>
                <h3 className="mt-4 text-base font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {step.description}
                </p>
              </li>
            ))}
          </ol>
          <p className="mt-10 text-sm text-muted-foreground">
            Want to see what honest feedback actually looks like?{" "}
            <Link
              href="/honest-interview-feedback"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              See examples →
            </Link>
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Curious what an InterviewReplay report actually looks like?{" "}
            <Link
              href="/sample-report"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              See a real sample →
            </Link>
          </p>
        </div>
      </section>

      <Testimonials />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            reviewSchema
              ? { ...softwareApplicationSchema, review: reviewSchema }
              : softwareApplicationSchema,
          ),
        }}
      />
    </>
  );
}
