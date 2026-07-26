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
  title: "InterviewReplay — AI Interview Coaching for Professionals",
  description:
    "Record your voice during real FAANG, SDE-2, senior, staff, and PM interviews. Get structured AI feedback on every answer — clarity, structure, filler words, STAR completeness. 2 free credits when you sign up.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "InterviewReplay — AI Interview Coaching for Professionals",
    description:
      "Record your real interview voice. Get structured AI coaching calibrated to the level you're targeting. Start free — 2 credits on sign-up.",
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
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    email: "hello@example.com",
    availableLanguage: "English",
  },
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
  offers: [
    {
      "@type": "Offer",
      name: "Free trial",
      price: "0",
      priceCurrency: "INR",
      description: "2 free analysis credits on sign-up — covers one 60-min interview or two 30-min rounds",
    },
    {
      "@type": "Offer",
      name: "Starter",
      price: "399",
      priceCurrency: "INR",
      description: "4 interview analysis credits, prices include 18% GST",
    },
    {
      "@type": "Offer",
      name: "Standard",
      price: "1199",
      priceCurrency: "INR",
      description: "14 interview analysis credits, prices include 18% GST",
    },
    {
      "@type": "Offer",
      name: "Heavy",
      price: "2899",
      priceCurrency: "INR",
      description: "36 interview analysis credits, prices include 18% GST",
    },
  ],
};

const faqs = [
  {
    q: "Why was InterviewReplay built?",
    a: "The team behind InterviewReplay is made up of ex-FAANG and current FAANG engineers. None of us cleared these interviews on the first try — it took multiple attempts, largely because we never got concrete feedback on what to improve. That made the journey longer and harder than it needed to be. InterviewReplay exists to fix that. You get detailed, section-by-section feedback on your performance along with an overall InterviewReplay verdict. Review each section carefully, practice the suggested questions, and build a history of your interviews so you can come back, see how you've grown, and walk into the next tough interview honestly prepared.",
  },
  {
    q: "Is InterviewReplay available outside India?",
    a: "InterviewReplay is currently available in India. We plan to expand to other markets — sign up to stay updated.",
  },
  {
    q: "What if I'm interviewing with a company outside India?",
    a: "Many Indian engineers interview with global companies — that's fine. If your interviewer is based outside India, please review the recording laws applicable to their jurisdiction. InterviewReplay provides the tool; you ensure compliance with local laws in your specific situation.",
  },
  {
    q: "Does it record the interviewer?",
    a: "No. InterviewReplay only records your microphone. Wear headphones during the interview and the interviewer's voice never reaches the recording.",
  },
  {
    q: "How is my data protected?",
    a: "Your audio is processed and deleted within 60 seconds of transcription. We comply with the Digital Personal Data Protection Act 2023 and never use your data for AI training. You can delete your account and all data at any time.",
  },
  {
    q: "Can I delete my data?",
    a: "Yes. Every recording, transcript, and report can be deleted from your dashboard at any time. Account deletion wipes everything within 30 days, including backups.",
  },
  {
    q: "How accurate is the feedback?",
    a: "Our analysis pipeline transcribes your audio, redacts personal info, and scores it against the rubric for the level you targeted. It's good at flagging clarity, structure, filler words, and STAR-completeness for behavioral answers. It's not infallible — treat it like a thoughtful peer review, not a hiring decision.",
  },
  {
    q: "Does this work for non-engineering interviews?",
    a: "Yes. The behavioral and 'other' round types cover product, design, business, sales, and most other formats. The rubric for technical-only signals (e.g. system design depth) only fires for the matching round type, so a PM behavioral interview won't be unfairly penalized.",
  },
  {
    q: "How does the free trial work?",
    a: "When you create your InterviewReplay account, we give you 2 credits to try the product. You can use them however you want — analyze one full 60-minute interview, or two 30-minute rounds, or one 30-minute round and save the rest for later. Credits never expire. After your free credits are used, you can buy a credit pack starting at ₹399.",
  },
] as const;

export default async function HomePage() {
  // Auth-aware hero CTA: signed-in users have already done the
  // "get your free analysis" funnel — pushing them at /signup again
  // is a dead-end. Send them to the dashboard instead.
  const session = await auth();
  const isSignedIn = Boolean(session?.user?.id);

  // Fetch testimonial JSON-LD in parallel with the section render.
  // The Testimonials component does its own fetch (single source of
  // truth for the limit + cap), so this second call is effectively
  // a cache hit at the DB layer — same partial index, same query.
  // Could optimise to one fetch later by lifting state up, but the
  // current overhead is one extra index scan on a tiny table.
  const reviewSchema = await getTestimonialsReviewSchema();

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.a,
      },
    })),
  };

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
          <p className="mt-3 text-sm text-muted-foreground/80">
            <em>InterviewReplay</em> (अञ्जुरि) means &ldquo;cupped hands&rdquo; in
            Sanskrit &mdash; the gesture of holding something precious to
            examine it carefully.
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
                  Get your free analysis
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
            )}
            <Button asChild size="lg" variant="outline">
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
          {!isSignedIn && !features.inviteOnlyBeta && (
            <p className="mt-4 text-xs text-muted-foreground">
              Your first interview free, up to 60 minutes. No credit card
              required to start.
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

      <section
        id="demo"
        aria-labelledby="demo-heading"
        className="border-t border-border"
      >
        <div className="mx-auto max-w-4xl px-6 py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2
              id="demo-heading"
              className="text-3xl font-semibold tracking-tight sm:text-4xl"
            >
              See InterviewReplay in action
            </h2>
            <p className="mt-3 text-base text-muted-foreground">
              A walkthrough of how to record your interview and read the
              feedback report.
            </p>
          </div>

          <div className="mt-10 overflow-hidden rounded-xl border border-border shadow-sm">
            <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
              <iframe
                className="absolute inset-0 h-full w-full"
                src="https://www.youtube.com/embed/fDIoQH67mGc?vq=hd4320"
                title="How to use InterviewReplay — AI interview feedback walkthrough"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            </div>
          </div>
        </div>
      </section>

      <Testimonials />

      <section
        id="pricing-teaser"
        className="border-t border-border"
        aria-labelledby="pricing-teaser-heading"
      >
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-6 py-20 text-center">
          <h2
            id="pricing-teaser-heading"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            First analysis free. Then pay only for what you use.
          </h2>
          <p className="max-w-xl text-base text-muted-foreground">
            No subscription. Buy credits, use them when you interview. Packs
            start at ₹399 (incl. 18% GST). Credits never expire.
          </p>
          <Button asChild size="lg" variant="primary" className="mt-2">
            <Link href="/pricing">
              See pricing
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </Button>
        </div>
      </section>

      <section
        id="faq"
        aria-labelledby="faq-heading"
        className="border-t border-border bg-muted/30"
      >
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2
            id="faq-heading"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            Frequently asked questions
          </h2>

          <div className="mt-10 divide-y divide-border">
            {faqs.map((faq) => (
              <details key={faq.q} className="group py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-medium text-foreground">
                  <span>{faq.q}</span>
                  <span
                    aria-hidden
                    className="text-muted-foreground transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {faq.a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          // Splice in featured-testimonial reviews when there are
          // any. Search engines treat product-attached reviews
          // (review array on SoftwareApplication) more strictly than
          // free-floating Review nodes, which is what we want — so
          // we attach them here rather than emitting a separate
          // <script> tag.
          __html: JSON.stringify(
            reviewSchema
              ? { ...softwareApplicationSchema, review: reviewSchema }
              : softwareApplicationSchema,
          ),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
    </>
  );
}
