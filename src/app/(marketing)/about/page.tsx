import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About InterviewReplay — AI Interview Coaching Built by FAANG Engineers",
  description:
    "InterviewReplay was built by ex-FAANG engineers who failed interviews because they never got real feedback. Learn why we built an AI coach that analyzes your actual interview performance — not mock scenarios.",
  alternates: { canonical: "/about" },
  openGraph: {
    title: "About InterviewReplay — AI Interview Coaching Built by FAANG Engineers",
    description:
      "Built by ex-FAANG engineers who failed because they never got real feedback. InterviewReplay analyzes your actual interview recordings and tells you exactly what to improve.",
    url: "/about",
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

export default function AboutPage() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
        Why InterviewReplay exists
      </h1>

      <p className="mt-3 text-sm text-muted-foreground/80">
        <em>InterviewReplay</em> (अञ्जुरि) means &ldquo;cupped hands&rdquo; in Sanskrit
        &mdash; the gesture of holding something precious to examine it
        carefully. It&apos;s how we think about an interview: not a one-shot
        event, but a moment worth slowing down on.
      </p>

      <div className="mt-8 space-y-6 text-base leading-relaxed text-muted-foreground">
        <p>
          Most interview prep happens on a whiteboard, in mock interviews, or
          alone in front of a mirror. The actual interview &mdash; the one
          that matters &mdash; is treated as a single high-stakes event. You
          walk out, try to remember what you said, and hope you did okay.
        </p>
        <p>
          InterviewReplay was built to close that gap. Your real interviews are the
          highest-signal data you have about how you perform under pressure.
          By recording your microphone &mdash; and only your microphone &mdash;
          and analyzing the conversation afterward, every interview becomes a
          coaching session.
        </p>
      </div>

      <div className="mt-14 rounded-xl border border-border bg-muted/30 p-6">
        <h2 className="text-lg font-semibold text-foreground">
          Why we started with India
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          India produces some of the world&apos;s strongest engineers, and
          most of them are interviewing at high stakes &mdash; for FAANG
          offers, senior roles at Indian unicorns, global remote positions.
          The competition is fierce, and the feedback loop is broken: most
          candidates never learn why they were rejected. We built InterviewReplay to
          fix that, starting here.
        </p>
      </div>

      <div className="mt-8 rounded-xl border border-border bg-muted/30 p-6">
        <h2 className="text-lg font-semibold text-foreground">
          No surveillance, only reflection
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          InterviewReplay only ever records your own voice. We never capture the
          interviewer, your screen, or your camera. The product&apos;s
          purpose is reflection, not monitoring &mdash; your recordings are
          scoped to you, encrypted at rest, and deletable on demand. We
          don&apos;t sell your data, and we don&apos;t use your recordings to
          train third-party models.
        </p>
      </div>

      <div className="mt-8 rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground">
          Your data, your server
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Audio is transcribed locally using Whisper, then
          deleted within 60 seconds. Your data never leaves your server and is
          never used for model training. You can delete your account and all
          data at any time.
        </p>
      </div>

      <div className="mt-8 rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground">
          Honesty over hype
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          We&apos;d rather tell you the unflattering thing about an answer
          you gave than dress it up. The feedback is structured, level-aware,
          and grounded in what you actually said &mdash; quoted back to you,
          not summarized into uselessness.
        </p>
      </div>

      <p className="mt-10 text-sm text-muted-foreground">
        For anything else, the founders are reachable at{" "}
        <a
          href="mailto:founders@example.com"
          className="text-foreground underline underline-offset-2"
        >
          founders@example.com
        </a>
        .
      </p>
    </section>
  );
}
