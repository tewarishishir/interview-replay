import type { Metadata } from "next";
import Link from "next/link";

import {
  ACCOUNT_DELETION_GRACE_DAYS,
  PRIVACY_CONTACT_EMAIL,
  SUPPORT_CONTACT_EMAIL,
  TERMS_VERSION_DATE,
} from "@/lib/compliance/constants";

export const metadata: Metadata = {
  title: "Terms",
  description: "Terms of service for using InterviewReplay. India-only service.",
};

export default function TermsPage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-20">
      <header className="border-b border-border pb-6">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Effective {TERMS_VERSION_DATE}. By using InterviewReplay you agree to these
          Terms. Questions:{" "}
          <a
            className="text-foreground underline"
            href={`mailto:${SUPPORT_CONTACT_EMAIL}`}
          >
            {SUPPORT_CONTACT_EMAIL}
          </a>
          .
        </p>
      </header>

      <div className="mt-10 space-y-12 text-base leading-relaxed text-muted-foreground">
        <Section heading="1. Acceptable use">
          <p className="mt-3">
            InterviewReplay provides services to users in <strong>India</strong>. By
            accepting these Terms, you represent that you are located in
            India when you use the service.
          </p>
          <p className="mt-3">
            You agree that you will use InterviewReplay only for interviews where{" "}
            <strong>both you and the interviewer are located in India</strong>,
            or for interviews where you have obtained explicit, informed
            consent from the interviewer to record the interview under
            applicable law in their jurisdiction. You are solely responsible
            for compliance with recording laws and any non-disclosure
            agreements applicable to your interviews.
          </p>
          <p className="mt-3">
            You also agree not to:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>Record interviews in which you are not a participant.</li>
            <li>
              Share, publish, or otherwise distribute another person&apos;s
              voice, words, or likeness without their consent.
            </li>
            <li>
              Use InterviewReplay to deceive an interviewer in real time or to evade
              an honest hiring process. The service is for after-the-fact
              reflection and learning.
            </li>
            <li>
              Attempt to circumvent technical restrictions, scrape data not
              belonging to you, or interfere with other users&apos; access.
            </li>
          </ul>
        </Section>

        <Section heading="2. Recording laws">
          <p className="mt-3">
            Recording laws vary significantly by jurisdiction. Many
            jurisdictions require consent from all parties to a recorded
            conversation. If your interviewer is located in a jurisdiction
            with such requirements, <strong>you must obtain their explicit
            consent</strong> before using InterviewReplay during the interview.
            Failure to do so may constitute a violation of applicable law.
            InterviewReplay is a tool; legal compliance is your responsibility.
          </p>
          <p className="mt-3">
            Within India, you affirm that you are recording your own voice
            for personal coaching and that doing so does not violate any
            agreement you have entered into.
          </p>
        </Section>

        <Section heading="3. Interviewer content">
          <p className="mt-3">
            InterviewReplay is designed to capture only your own voice and the content
            you manually share. <strong>You agree not to use InterviewReplay to
            deliberately record other parties without their consent.</strong>{" "}
            You acknowledge that recording the other party&apos;s voice
            through your microphone &mdash; for example, through laptop
            speakers without headphones &mdash; may violate applicable law,
            and you agree to use headphones or take other reasonable measures
            to prevent inadvertent capture.
          </p>
        </Section>

        <Section heading="4. Your affirmation each time you record">
          <p className="mt-3">
            Every time you start a recording session in InterviewReplay, you affirm
            that:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>You are recording <strong>only yourself</strong>.</li>
            <li>
              You have the legal right to record the interview in your
              jurisdiction (and the interviewer&apos;s jurisdiction, if
              different).
            </li>
            <li>
              The recording does not violate any non-disclosure agreement,
              employment contract, or other obligation you have.
            </li>
            <li>
              You are wearing headphones (or have otherwise prevented the
              interviewer&apos;s audio from being captured by your microphone).
            </li>
          </ul>
        </Section>

        <Section heading="5. NDAs and confidentiality">
          <p className="mt-3">
            Many companies require interview candidates to sign non-disclosure
            agreements covering interview content, company-confidential
            coding problems, system designs, and similar material.{" "}
            <strong>You are solely responsible for understanding and
            complying with any NDA you have signed.</strong>
          </p>
          <p className="mt-3">
            InterviewReplay encrypts your data in transit and at rest, scopes it to
            your account, and never trains models on your content. But the
            existence of a recording is not by itself an NDA defence; you
            must decide for yourself whether recording a particular
            interview is consistent with your agreements.
          </p>
        </Section>

        <Section heading="6. Data subject rights (DPDP)">
          <p className="mt-3">
            You have the rights of a Data Principal under the Digital
            Personal Data Protection Act, 2023 &mdash; including access,
            correction, erasure, grievance redressal, and withdrawal of
            consent. The mechanics live in our{" "}
            <Link className="text-foreground underline" href="/privacy">
              Privacy Policy
            </Link>
            .
          </p>
        </Section>

        <Section heading="7. AI-generated content">
          <p className="mt-3">
            InterviewReplay uses AI models running on your self-hosted server
            to produce feedback, AI-inferred questions, and Practice Rebuild
            critiques. AI output can be wrong or misleading. The reports,
            inferred questions, and critique are <strong>practice
            material</strong>, not professional career advice and not a
            guarantee of any interview outcome.
          </p>
          <p className="mt-3">
            Practice Rebuild is a coaching tool, not an answer-generation
            tool. The critique provided is feedback on your own draft, not a
            script to recite. We strongly recommend treating rebuilds as
            practice for your own thinking, not as content to memorise
            verbatim.
          </p>
        </Section>

        <Section heading="8. The service, and what it does not promise">
          <p className="mt-3">
            We aim for high availability but make no uptime guarantee.
            Scheduled maintenance, infrastructure outages, and other interruptions may happen.
          </p>
          <p className="mt-3 uppercase tracking-wide text-foreground">
            <strong>
              The service is provided &quot;as is&quot; without warranty of
              any kind, express or implied, to the fullest extent allowed by
              law. We disclaim all warranties including merchantability,
              fitness for a particular purpose, accuracy, and
              non-infringement.
            </strong>
          </p>
        </Section>

        <Section heading="9. Limitation of liability">
          <p className="mt-3 uppercase tracking-wide text-foreground">
            <strong>
              In no event will InterviewReplay be liable for indirect, incidental,
              consequential, special, or punitive damages, or for any lost
              profits or revenues, arising out of or relating to your use of
              the service. Our aggregate liability for any claim is limited
              to the amount you paid us in the twelve months preceding the
              claim, subject to the limits of the Consumer Protection Act,
              2019.
            </strong>
          </p>
        </Section>

        <Section heading="10. Refunds and credits">
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              <strong>Consumed credits are non-refundable.</strong> Once an
              analysis is generated and visible to you, the credit is spent.
            </li>
            <li>
              <strong>Failed analyses are refunded automatically</strong> (a
              report that fails to generate due to corrupted audio,
              insufficient transcript length, or upstream model outage). The
              credit returns to your balance.
            </li>
            <li>
              Credit adjustments are handled by the instance administrator.
            </li>
          </ul>
        </Section>

        <Section heading="11. Termination and data retention">
          <p className="mt-3">
            <strong>You may terminate</strong> your account at any time from
            account settings. We initiate a {ACCOUNT_DELETION_GRACE_DAYS}-day
            grace period during which you can sign back in to cancel; after
            that we permanently delete your data per the Privacy Policy.
            Unused credits at termination are refundable within the 30-day
            window above.
          </p>
          <p className="mt-3">
            <strong>We may suspend or terminate</strong> your account
            without notice if we believe you have materially breached these
            Terms or if your use exposes us or third parties to legal risk.
            Where the issue is clearly an honest mistake we will give you a
            chance to fix it first.
          </p>
        </Section>

        <Section heading="12. Intellectual property">
          <p className="mt-3">
            You retain all rights to your audio, transcripts, artifacts, and
            reports. You grant us a limited license to store, transcribe,
            analyse, and display that content <em>solely</em> to deliver the
            service to you.
          </p>
          <p className="mt-3">
            We retain all rights in the InterviewReplay software, brand, and
            documentation. The interview-pattern heuristics and summary
            statistics we compute across all users are strictly aggregated
            and de-identified.
          </p>
        </Section>

        <Section heading="13. Governing law and jurisdiction">
          <p className="mt-3">
            These Terms are governed by the laws of India. Any disputes
            arising out of or in connection with these Terms shall be
            subject to the exclusive jurisdiction of the competent courts
            of India.
          </p>
        </Section>

        <Section heading="14. Changes to these terms">
          <p className="mt-3">
            We may update these Terms as the product evolves. Material
            changes will be communicated via email at least 14 days in
            advance, and you will be asked to review and accept the new
            Terms the next time you sign in. Continued use after the
            effective date constitutes acceptance of the updated Terms.
          </p>
          <p className="mt-3 text-sm">
            See also the{" "}
            <Link className="text-foreground underline" href="/privacy">
              Privacy Policy
            </Link>{" "}
            for how we handle your data, and reach us at{" "}
            <a
              className="text-foreground underline"
              href={`mailto:${PRIVACY_CONTACT_EMAIL}`}
            >
              {PRIVACY_CONTACT_EMAIL}
            </a>{" "}
            for privacy questions.
          </p>
        </Section>
      </div>
    </article>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-xl font-semibold text-foreground">{heading}</h2>
      {children}
    </section>
  );
}
