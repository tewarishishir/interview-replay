import type { Metadata } from "next";
import Link from "next/link";

import {
  ACCOUNT_DELETION_GRACE_DAYS,
  PRIVACY_CONTACT_EMAIL,
  TERMS_VERSION_DATE,
} from "@/lib/compliance/constants";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "How InterviewReplay handles your data. DPDP Act 2023 compliant. India-only service.",
};

/**
 * DPDP Act 2023-compliant privacy policy.
 *
 * Structured to match the statutory requirements:
 *   - clear, informed, voluntary consent
 *   - purpose limitation, data minimization, storage limitation
 *   - rights of the Data Principal (access, correction, deletion,
 *     grievance, withdrawal of consent)
 *   - grievance officer / DPO contact
 *   - breach notification (handled operationally, mentioned here)
 *   - cross-border transfer disclosure (now self-hosted; no data leaves server)
 *
 * Numbers and dates that aren't legal copy live in `lib/compliance/
 * constants.ts` so the policy never silently drifts from what the
 * code actually does.
 */
export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-20">
      <header className="border-b border-border pb-6">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Effective {TERMS_VERSION_DATE}. For privacy questions, data-subject
          requests, and Data Protection Officer / grievance redressal, write
          to{" "}
          <a
            className="text-foreground underline"
            href={`mailto:${PRIVACY_CONTACT_EMAIL}`}
          >
            {PRIVACY_CONTACT_EMAIL}
          </a>
          .
        </p>
      </header>

      <div className="mt-10 space-y-12 text-base leading-relaxed text-muted-foreground">
        <Section heading="Region and applicability">
          <p className="mt-3">
            InterviewReplay is currently available <strong>only to users in India</strong>.
            This policy is written under the Digital Personal Data Protection
            Act, 2023 (the &ldquo;DPDP Act&rdquo;) and applies to all
            personal data we process about you. By creating an account you
            represent that you are located in India and that you consent to
            the processing described below.
          </p>
        </Section>

        <Section heading="Your consent">
          <p className="mt-3">
            We process your personal data only with your explicit, informed,
            and voluntary consent, given at signup and whenever we add a new
            processing purpose. You may withdraw consent at any time by
            emailing{" "}
            <a
              className="text-foreground underline"
              href={`mailto:${PRIVACY_CONTACT_EMAIL}`}
            >
              {PRIVACY_CONTACT_EMAIL}
            </a>{" "}
            or by deleting your account from the account settings page.
            Withdrawing consent stops future processing but does not affect
            processing already lawfully carried out.
          </p>
        </Section>

        <Section heading="What we collect">
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              <strong>Your email address</strong>, to sign you in and to send
              transactional notices.
            </li>
            <li>
              <strong>The audio of your voice</strong> while you are
              recording an interview. We delete the original recording within
              60 seconds of transcription.
            </li>
            <li>
              <strong>The transcript</strong> we generate from that audio,
              with personally-identifying information automatically redacted.
            </li>
            <li>
              <strong>Anything you manually add</strong> to a session: notes,
              code, diagrams, screenshots you upload.
            </li>
            <li>
              <strong>Interview outcomes you choose to record</strong> &mdash;
              whether you advanced, received an offer, were rejected, or
              withdrew. Optional. Used only to improve your personalised
              coaching. Never shared with the companies you interviewed with.
            </li>
            <li>
              <strong>Basic usage analytics</strong>: which pages you viewed,
              which buttons you clicked. Anonymised; we never include
              transcript or report content in analytics events.
            </li>
            <li>
              <strong>Standard server logs</strong> (IP address, user agent,
              request timestamps) for security and abuse prevention. Retained
              for 30 days.
            </li>
            <li>
              <strong>Country code derived from your signup IP</strong>,
              used to enforce our India-only access policy. Not used for
              advertising or shared with third parties.
            </li>
          </ul>
        </Section>

        <Section heading="What we don't collect">
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              <strong>The interviewer&rsquo;s voice.</strong> InterviewReplay only
              records your microphone, never the other side of the call.
            </li>
            <li>
              <strong>Your screen</strong> or anything happening on it.
            </li>
            <li>
              <strong>Your camera or video.</strong>
            </li>
            <li>
              <strong>Your location</strong> (beyond the country code derived
              from your IP, as noted above).
            </li>
            <li>
              <strong>Your contacts</strong>, calendar, or other personal
              data outside of InterviewReplay.
            </li>
            <li>
              <strong>Biometric data.</strong> We do not derive voice prints,
              face prints, or any other biometric identifier from your audio.
              The audio is transcribed, then deleted.
            </li>
            <li>
              <strong>Payment card or financial details.</strong> This is a
              self-hosted application. No payment processing occurs; all
              features are free.
            </li>
          </ul>
        </Section>

        <Section heading="Where your data is stored">
          <p className="mt-3">
            InterviewReplay stores data on self-hosted infrastructure. Your transcripts,
            reports, profile, and all account metadata are stored in encrypted
            databases. Audio recordings live in encrypted local storage for
            up to 60 seconds before deletion.
          </p>
        </Section>

        <Section heading="Cross-border transfers (disclosure)">
          <p className="mt-3">
            All AI processing (transcription and analysis) happens on your
            self-hosted server. No audio, transcript, or personal data is sent
            to external AI providers.
          </p>
        </Section>

        <Section heading="Practice Rebuild">
          <p className="mt-3">
            When you use Practice Rebuild, your draft answers and your
            profile are processed by AI to provide structural critique and
            evidence-pointing. InterviewReplay does not write or generate answer
            content on your behalf &mdash; the AI critiques what you write
            and points you at facts you&rsquo;ve already provided in your
            profile. Drafts and critiques are encrypted, used only for your
            coaching, and never used for model training.
          </p>
        </Section>

        <Section heading="How long we keep things">
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              <strong>Audio recordings: 60 seconds.</strong> Deleted from
              object storage within 60 seconds of transcription. A separate
              enforcement job pages an operator if a recording is still
              around after one hour.
            </li>
            <li>
              <strong>Transcripts and artifacts: kept until you delete your account.</strong>{" "}
              We do not automatically delete your interview transcripts or
              session data. They remain available to you for as long as your
              account exists. Only audio recordings are deleted automatically
              (within 60 seconds of transcription).
            </li>
            <li>
              <strong>Analysis reports: until you delete them.</strong>{" "}
              We keep AI-generated reports indefinitely so you can revisit
              them. You can delete any report individually or wipe all of
              them by deleting your account.
            </li>
            <li>
              <strong>
                Account data: {ACCOUNT_DELETION_GRACE_DAYS} days after a
                deletion request.
              </strong>{" "}
              Signing back in cancels it. Financial records (purchase rows,
              GST line items) are anonymised but retained where Indian tax
              law requires.
            </li>
            <li>
              <strong>Server logs: 30 days.</strong>
            </li>
          </ul>
        </Section>

        <Section heading="Who else processes your data">
          <p className="mt-3">
            Each processor below is contractually prohibited from training
            on your data or using it for any purpose beyond serving InterviewReplay:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              <strong>Self-hosted AI</strong> &mdash; speech-to-text
              (Whisper) and LLM analysis run locally on your server. No
              audio or transcript data leaves your infrastructure.
            </li>
            <li>
              <strong>Local encrypted storage</strong> &mdash; encrypted file storage
              for audio in transit; encrypted Postgres for
              metadata and transcripts.
            </li>
            <li>
              <strong>Commodity infrastructure</strong> &mdash; we use
              third-party vendors for hosting, edge protection, transactional
              email, background job orchestration, error tracking, and
              product analytics. These vendors receive only the minimum data
              they need to function, are contractually prohibited from
              training on or selling your data, and never see audio or full
              transcripts.
            </li>
          </ul>
        </Section>

        <Section heading="Your rights under the DPDP Act">
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              <strong>Right to access:</strong> view all your sessions,
              transcripts, reports, and profile inside the app.
            </li>
            <li>
              <strong>Right to correction:</strong> edit transcripts, profile
              fields, and any interview outcome you have recorded.
            </li>
            <li>
              <strong>Right to erasure:</strong> delete individual sessions,
              individual reports, or your entire account (with a{" "}
              {ACCOUNT_DELETION_GRACE_DAYS}-day grace period) from account
              settings. We action this within the statutory window.
            </li>
            <li>
              <strong>Right to grievance redressal:</strong> contact our Data
              Protection Officer at{" "}
              <a
                className="text-foreground underline"
                href={`mailto:${PRIVACY_CONTACT_EMAIL}`}
              >
                {PRIVACY_CONTACT_EMAIL}
              </a>
              . We respond within 30 days, sooner where possible. If we
              cannot resolve your complaint, you may approach the Data
              Protection Board of India.
            </li>
            <li>
              <strong>Right to withdraw consent:</strong> stop future
              processing by emailing the addresses above or by deleting your
              account.
            </li>
            <li>
              <strong>Right to nominate</strong> (where applicable):
              designate another person to exercise your rights in case of
              incapacity.
            </li>
          </ul>
        </Section>

        <Section heading="Breach notification">
          <p className="mt-3">
            If a personal data breach affects your account we will notify
            you within 72 hours of confirmation, alongside the Data
            Protection Board of India, per the DPDP Act. Notifications will
            explain what was affected, what we have done in response, and
            what steps you can take.
          </p>
        </Section>

        <Section heading="Contact">
          <p className="mt-3">
            Privacy questions, data-subject requests, security disclosures,
            and DPDP grievances all go to{" "}
            <a
              className="text-foreground underline"
              href={`mailto:${PRIVACY_CONTACT_EMAIL}`}
            >
              {PRIVACY_CONTACT_EMAIL}
            </a>
            . We respond personally to each one.
          </p>
        </Section>

        <Section heading="Updates">
          <p className="mt-3">
            We will notify you by email at least 14 days before any material
            change to this policy takes effect. The first time you sign in
            after an update you will see a banner asking you to review and
            accept the new policy before continuing.
          </p>
          <p className="mt-3 text-sm">
            See also the{" "}
            <Link className="text-foreground underline" href="/terms">
              Terms of Service
            </Link>
            .
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
