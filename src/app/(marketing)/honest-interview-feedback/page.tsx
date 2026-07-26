// TODO: Replace public/og/ir-og-honest-feedback.png with the final branded
// 1200×630 OG image before launch. The current placeholder is a copy of the
// generic og-image.png. LinkedIn/Twitter cards will silently fall back to
// nothing if the file is absent or wrong-sized, so no page breakage.

import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";

const BASE_URL = "https://localhost:3000";

export const metadata: Metadata = {
  title: "Honest Interview Feedback That Tells You What Actually Went Wrong | InterviewReplay",
  description:
    "Real coaching from your actual interview — not generic tips. InterviewReplay analyzes the interview you had and tells you specifically what to fix. No scripts. No shortcuts.",
  alternates: {
    canonical: `${BASE_URL}/honest-interview-feedback`,
  },
  openGraph: {
    title: "Honest Interview Feedback — From the Interview You Actually Had",
    description:
      "Real coaching from your actual interview. No scripts. No shortcuts. InterviewReplay analyzes the interview you had and tells you specifically what to fix.",
    url: `${BASE_URL}/honest-interview-feedback`,
    siteName: "InterviewReplay",
    images: [
      {
        url: `${BASE_URL}/og/ir-og-honest-feedback.png`,
        width: 1200,
        height: 630,
        alt: "Honest Interview Feedback — InterviewReplay",
      },
    ],
    locale: "en_IN",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Honest Interview Feedback — From the Interview You Actually Had",
    description:
      "Real coaching from your actual interview. No scripts. No shortcuts.",
    images: [`${BASE_URL}/og/ir-og-honest-feedback.png`],
  },
};

const serviceSchema = {
  "@context": "https://schema.org",
  "@type": "Service",
  serviceType: "Interview Coaching",
  name: "Honest Interview Feedback by InterviewReplay",
  description:
    "AI-powered analysis of your real interviews, with specific feedback on what worked, what didn't, and what to fix before the next interview.",
  provider: {
    "@type": "Organization",
    name: "InterviewReplay",
    url: BASE_URL,
  },
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    description: "Free and open source under the MIT license",
  },
};

export default function HonestInterviewFeedbackPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(serviceSchema) }}
      />

      {/* Section 1: H1 + opening */}
      <section className="mx-auto max-w-3xl px-6 py-24 sm:py-32">
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          Honest Interview Feedback — From the Interview You Actually Had
        </h1>
        <p className="mt-6 text-pretty text-lg leading-relaxed text-muted-foreground">
          You walked out of an interview unsure how it went. A week later, you
          got the rejection email. The feedback, if you got any, was something
          like &ldquo;strong technical signal but communication needs
          work&rdquo; or &ldquo;we went with a candidate whose background was a
          closer match.&rdquo; You&apos;re left guessing what actually went
          wrong.
        </p>
        <p className="mt-4 text-lg font-medium text-foreground">
          That&apos;s the gap InterviewReplay exists to fill.
        </p>
      </section>

      {/* Section 2: What honest interview feedback actually looks like */}
      <section
        id="what-it-looks-like"
        aria-labelledby="what-it-looks-like-heading"
        className="border-t border-border bg-muted/30"
      >
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2
            id="what-it-looks-like-heading"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            What honest interview feedback actually looks like
          </h2>
          <div className="mt-6 space-y-4 text-base leading-relaxed text-muted-foreground">
            <p>
              Most interview prep tools give you generic advice. &ldquo;Use the
              STAR method.&rdquo; &ldquo;Quantify your results.&rdquo;
              &ldquo;Practice your tell-me-about-yourself.&rdquo; This
              isn&apos;t wrong &mdash; it&apos;s just not feedback. It&apos;s
              prescription dressed up as personalization, the same prescription
              everyone gets.
            </p>
            <p>
              Real feedback looks different. It points to the specific moment
              you said &ldquo;we built the system&rdquo; when you should have
              said &ldquo;I architected the system.&rdquo; It tells you that
              your story about the production incident took 4 minutes when it
              should have taken 90 seconds. It notes that you mentioned the
              Stripe migration once in passing when the question was begging for
              a deeper version of that exact story.
            </p>
            <p>
              InterviewReplay produces this kind of feedback because it analyzes the
              actual interview you had &mdash; not a mock interview, not a
              practice session, but the real conversation. You record your side
              of the conversation, InterviewReplay transcribes it and analyzes it against
              your background and the level you&apos;re targeting, and the
              report tells you specifically what to fix.
            </p>
          </div>
        </div>
      </section>

      {/* Section 3: Why 'honest' is the operative word */}
      <section
        id="why-honest"
        aria-labelledby="why-honest-heading"
        className="border-t border-border"
      >
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2
            id="why-honest-heading"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            Why &ldquo;honest&rdquo; is the operative word
          </h2>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            We built InterviewReplay because the existing tools are dishonest in three
            ways:
          </p>
          <ul className="mt-8 space-y-4">
            <li className="rounded-xl border border-border bg-background p-6">
              <p className="text-base leading-relaxed text-muted-foreground">
                <strong className="font-semibold text-foreground">
                  They give you scores with no explanation.
                </strong>{" "}
                Generic &ldquo;85/100 confidence&rdquo; or &ldquo;75/100
                articulation&rdquo; numbers feel concrete but mean nothing on
                their own. InterviewReplay scores are always grounded in your actual
                words &mdash; every number comes with specific quotes from your
                transcript and specific observations about what those quotes
                reveal.
              </p>
            </li>
            <li className="rounded-xl border border-border bg-background p-6">
              <p className="text-base leading-relaxed text-muted-foreground">
                <strong className="font-semibold text-foreground">
                  They write your answers for you.
                </strong>{" "}
                Plenty of tools generate polished STAR responses in seconds.
                They suggest the exact words to say. They let you walk into your
                interview with a script. The problem is that interviewers
                &mdash; especially senior ones &mdash; can tell. The candidate
                who recites a polished AI answer falls apart on the first
                follow-up question because they don&apos;t actually own the
                story. InterviewReplay analyzes what you said and shows you how to
                sharpen it. The words stay yours.
              </p>
            </li>
            <li className="rounded-xl border border-border bg-background p-6">
              <p className="text-base leading-relaxed text-muted-foreground">
                <strong className="font-semibold text-foreground">
                  They flatter you.
                </strong>{" "}
                Most AI coaching tools are tuned to be encouraging because
                encouragement drives engagement and retention. InterviewReplay tells you
                when your answer was structurally weak, even when that&apos;s
                uncomfortable. The candidate who hears &ldquo;this story
                didn&apos;t land&rdquo; gets to fix it. The candidate who hears
                &ldquo;great job!&rdquo; doesn&apos;t.
              </p>
            </li>
          </ul>
        </div>
      </section>

      {/* Section 4: How InterviewReplay analyzes your real interview */}
      <section
        id="how-it-works"
        aria-labelledby="how-it-works-heading"
        className="border-t border-border bg-muted/30"
      >
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2
            id="how-it-works-heading"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            How InterviewReplay analyzes your real interview
          </h2>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            The flow is simple. You start a session before the interview. InterviewReplay
            records your voice during the conversation (just your side &mdash;
            the interviewer&apos;s voice isn&apos;t captured). After the
            interview ends, you stop the recording. Within a few minutes, InterviewReplay
            produces a structured report.
          </p>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            The report gives you scores across key dimensions &mdash; and for
            every score, the evidence: specific quotes from your transcript and
            observations about what those quotes reveal. Then it tells you four
            things:
          </p>
          <ul className="mt-8 space-y-4">
            <li className="rounded-xl border border-border bg-background p-6">
              <p className="text-base leading-relaxed text-muted-foreground">
                <strong className="font-semibold text-foreground">
                  What worked.
                </strong>{" "}
                Specific moments where your answer landed &mdash; quotes from
                your transcript with notes on why those answers were strong.
              </p>
            </li>
            <li className="rounded-xl border border-border bg-background p-6">
              <p className="text-base leading-relaxed text-muted-foreground">
                <strong className="font-semibold text-foreground">
                  What didn&apos;t.
                </strong>{" "}
                Specific moments where you fell short &mdash; also with quotes,
                with concrete notes on what was missing (a quantified result, a
                clearer ownership signal, a tighter structure).
              </p>
            </li>
            <li className="rounded-xl border border-border bg-background p-6">
              <p className="text-base leading-relaxed text-muted-foreground">
                <strong className="font-semibold text-foreground">
                  What you should have used.
                </strong>{" "}
                If you have stories or projects in your InterviewReplay profile that
                would have been stronger fits for specific questions, the report
                tells you which ones you missed.
              </p>
            </li>
            <li className="rounded-xl border border-border bg-background p-6">
              <p className="text-base leading-relaxed text-muted-foreground">
                <strong className="font-semibold text-foreground">
                  What to fix before the next interview.
                </strong>{" "}
                Concrete, ranked improvements &mdash; not generic tips, but
                specific changes anchored to your specific answers.
              </p>
            </li>
          </ul>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            You read the report. You see exactly what to change. You walk into
            the next interview sharper.
          </p>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            You can{" "}
            <Link
              href="/sample-report"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              see a real sample report here →
            </Link>
          </p>
        </div>
      </section>

      {/* Section 5: Who InterviewReplay is for */}
      <section
        id="who-its-for"
        aria-labelledby="who-its-for-heading"
        className="border-t border-border"
      >
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2
            id="who-its-for-heading"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            Who InterviewReplay is for
          </h2>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            InterviewReplay is built for software engineers and tech professionals who
            want to understand specifically what went wrong in an interview
            &mdash; and fix it before the next one. Whether you&apos;re a
            fresh grad navigating your first rounds or a senior engineer going
            for a staff-level role, the problem is the same: you don&apos;t
            get useful feedback after rejections. InterviewReplay exists to change that.
          </p>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            It&apos;s not built for:
          </p>
          <ul className="mt-8 space-y-4">
            <li className="rounded-xl border border-border bg-background p-6">
              <p className="text-base leading-relaxed text-muted-foreground">
                <strong className="font-semibold text-foreground">
                  People who want to cheat.
                </strong>{" "}
                We don&apos;t write answers. We don&apos;t give you a script.
                We don&apos;t help you fake expertise you don&apos;t have.
              </p>
            </li>
            <li className="rounded-xl border border-border bg-background p-6">
              <p className="text-base leading-relaxed text-muted-foreground">
                <strong className="font-semibold text-foreground">
                  People who want to be told they&apos;re doing great.
                </strong>{" "}
                InterviewReplay&apos;s analysis is specific and unsparing. If an answer
                was weak, the report will say so. If you&apos;re not looking
                for that kind of feedback right now, InterviewReplay isn&apos;t the
                right tool.
              </p>
            </li>
          </ul>
        </div>
      </section>

      {/* Section 6: What honest feedback feels like */}
      <section
        id="what-it-feels-like"
        aria-labelledby="what-it-feels-like-heading"
        className="border-t border-border bg-muted/30"
      >
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2
            id="what-it-feels-like-heading"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            What honest feedback feels like
          </h2>
          <div className="mt-6 space-y-4 text-base leading-relaxed text-muted-foreground">
            <p>
              The pattern that shows up after a first InterviewReplay report:
              &ldquo;I knew that interview didn&apos;t go well, but I
              didn&apos;t know exactly why until I saw the report.&rdquo; The
              specific moments that decided the interview &mdash; the answer
              that was 30 seconds too long, the story that should have used a
              different example, the followup question you didn&apos;t quite
              address &mdash; become visible. Once you see them, you can fix
              them.
            </p>
            <p>
              Honest feedback is uncomfortable in the moment. It&apos;s also
              the only kind that compounds over time. By your third or fourth
              InterviewReplay-analyzed interview, you can see patterns in your
              performance &mdash; the same critique appearing in multiple
              reports &mdash; and you can target those patterns directly.
              That&apos;s how interview skill actually improves.
            </p>
          </div>
        </div>
      </section>

      {/* Section 7: Try InterviewReplay + CTA */}
      <section
        id="try-ir"
        aria-labelledby="try-ir-heading"
        className="border-t border-border"
      >
        <div className="mx-auto flex max-w-3xl flex-col items-start px-6 py-20">
          <h2
            id="try-ir-heading"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            Try InterviewReplay
          </h2>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            Your first interview analysis is free. No payment required, no
            subscription. Sign up, run a session, see what honest interview
            feedback actually looks like.
          </p>
          <Button asChild size="lg" variant="primary" className="mt-8">
            <Link href="/signup">
              Start your first analysis
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </Button>
          <p className="mt-4 text-xs text-muted-foreground">
            Free and open source under the MIT license.
          </p>
        </div>
      </section>
    </>
  );
}
