import type { Metadata } from "next";

import { ContactForm } from "@/components/marketing/contact-form";
import { PRIVACY_CONTACT_EMAIL } from "@/lib/compliance/constants";

export const metadata: Metadata = {
  title: "Contact InterviewReplay — Support & Feedback",
  description:
    "Questions about InterviewReplay's interview feedback, billing, or privacy? Send us a message — we read every one. For DPDP data requests email privacy@example.com directly.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: "Contact InterviewReplay — Support & Feedback",
    description:
      "Questions about interview feedback, billing, or your data? Reach the InterviewReplay team — we read every message.",
    url: "/contact",
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

/**
 * Public contact surface.
 *
 * Server component shell — the form itself is a client island
 * (`ContactForm`) because it needs `useState` + `fetch` for the
 * submission lifecycle. The shell renders without JS for SEO and so
 * a JS-disabled visitor still sees the contact instructions and the
 * privacy-questions fallback address.
 */
export default function ContactPage() {
  return (
    <section className="mx-auto max-w-2xl px-6 py-20">
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
        Contact us
      </h1>
      <p className="mt-4 text-base text-muted-foreground">
        Got a question, a bug report, or feedback on a feature? Send us a
        message and we&apos;ll get back to you. We read every one.
      </p>

      <div className="mt-10">
        <ContactForm />
      </div>

      <p className="mt-8 text-xs text-muted-foreground">
        For privacy-related requests (data access, deletion, grievance
        redressal under DPDP), please email{" "}
        <a
          className="text-foreground underline"
          href={`mailto:${PRIVACY_CONTACT_EMAIL}`}
        >
          {PRIVACY_CONTACT_EMAIL}
        </a>{" "}
        directly so the request lands with the right inbox.
      </p>
    </section>
  );
}
