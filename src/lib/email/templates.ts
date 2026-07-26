import "server-only";

import { sendEmail, type SendEmailResult } from "./client";
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  FEEDBACK_INBOX_EMAIL,
  PRIVACY_CONTACT_EMAIL,
  SUPPORT_CONTACT_EMAIL,
} from "@/lib/compliance/constants";
import { env } from "@/lib/env";

/**
 * Bare-bones HTML email templates. We deliberately stay on inline-
 * styled HTML rather than `react-email` for now: the templates are
 * small, the styling is minimal, and adding the `react-email`
 * runtime would balloon the install + render path with no user-
 * visible win at this stage. When the design pass lands a richer
 * template story, swap each `wrapHtml(...)` call for a `render(<Foo />)`
 * — `sendEmail()` doesn't care.
 *
 * Plain-text fallback is auto-derived from the HTML for clients
 * that don't render HTML.
 */

const APP_URL = (): string =>
  env.NEXTAUTH_URL?.replace(/\/+$/, "") ?? "http://localhost:3000";

/**
 * Format a UTC date as "Wed, May 6, 2026" — what we paste into
 * deletion / export emails. We deliberately stay in en-US locale +
 * UTC so the email reads consistently regardless of the recipient's
 * timezone (no "the email said May 6, my dashboard says May 7"
 * support tickets). Times of day are intentionally omitted — the
 * grace clock is per-day not per-hour.
 */
const formatDateUtc = (d: Date): string =>
  d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

type FooterCategory = "general" | "privacy" | "feedback_acknowledgment" | "founders";

// The founders personal inbox — reply-to for feedback acknowledgments and
// founder-authored emails. Hardcoded as a fallback for the footer copy;
// the actual Reply-To header is driven by env.EMAIL_REPLY_TO_FOUNDERS in client.ts.
const FOUNDERS_EMAIL = "founders@example.com";

/**
 * Category-aware footer. Each category directs replies to the appropriate
 * monitored Zoho inbox so users who reply to a transactional email end up
 * in the right place.
 *
 *   general                 → hello@example.com
 *   privacy                 → privacy@example.com
 *   feedback_acknowledgment → founders@example.com (personal founder reply)
 *   founders                → founders@example.com
 */
function buildFooter(category: FooterCategory): string {
  let contactLine: string;
  switch (category) {
    case "privacy":
      contactLine = `For privacy-related questions, data requests, or account deletion, contact <a href="mailto:${PRIVACY_CONTACT_EMAIL}" style="color:#2c5d63;">${PRIVACY_CONTACT_EMAIL}</a>. We respond to all DPDP-related requests within 30 days as required by law.`;
      break;
    case "feedback_acknowledgment":
    case "founders":
      contactLine = `Thanks for taking the time to share your thoughts. You can reply to this email to reach the founders directly, or write to us at <a href="mailto:${FOUNDERS_EMAIL}" style="color:#2c5d63;">${FOUNDERS_EMAIL}</a> anytime.`;
      break;
    case "general":
    default:
      contactLine = `Questions? Reply to this email or write to us at <a href="mailto:${SUPPORT_CONTACT_EMAIL}" style="color:#2c5d63;">${SUPPORT_CONTACT_EMAIL}</a>. We\u2019re a small team and we read every message.`;
  }

  return `<hr style="margin:32px 0 16px;border:none;border-top:1px solid #e5e7eb;" />
      <p style="margin:0;font-size:12px;color:#6b7280;">
        ${contactLine}
        <br /><br />
        <!-- TODO: replace with registered office address once the operating entity is incorporated -->
        InterviewReplay &bull; Bengaluru, India<br />
        &copy; 2026 InterviewReplay
      </p>`;
}

const wrapHtml = (
  heading: string,
  body: string,
  category: FooterCategory,
  ctaUrl?: string,
  ctaLabel?: string,
): string => {
  const cta =
    ctaUrl && ctaLabel
      ? `<p style="margin:32px 0 0;">
           <a href="${ctaUrl}" style="display:inline-block;padding:10px 18px;background:#2c5d63;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;">${ctaLabel}</a>
         </p>`
      : "";
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f7f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;">
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;letter-spacing:-0.01em;">${heading}</h1>
      <div style="font-size:14px;line-height:1.6;color:#374151;">${body}</div>
      ${cta}
      ${buildFooter(category)}
    </div>
  </body>
</html>`;
};

const stripHtml = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * HTML-escape user-controlled strings before interpolating into
 * email bodies/subjects. Other templates in this file
 * (sendAnalysisReadyEmail, etc.) have a pre-existing convention
 * of raw interpolation, but anything we add new should escape so
 * a candidate setting their company name to `<script>` doesn't
 * surprise their own inbox or, more importantly, surprise the
 * `stripHtml` text fallback. The blast radius is limited
 * (recipient is the user themselves), but encoding is the
 * correct posture for templating into HTML.
 */
const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");


export async function sendAnalysisReadyEmail(args: {
  to: string;
  sessionId: string;
  companyName: string;
  roleTitle: string;
}): Promise<SendEmailResult> {
  const html = wrapHtml(
    "Your analysis is ready",
    `<p>We've finished analyzing your <strong>${args.roleTitle}</strong> session at ${args.companyName}.</p>
     <p>Open it to see the executive summary, strengths, and concrete improvements.</p>`,
    "general",
    `${APP_URL()}/sessions/${args.sessionId}`,
    "View your analysis",
  );
  return sendEmail({
    to: args.to,
    subject: "Your InterviewReplay analysis is ready",
    html,
    text: stripHtml(html),
    category: "general",
  });
}

export async function sendWelcomeEmail(args: {
  to: string;
  name?: string | null;
}): Promise<SendEmailResult> {
  const greeting = args.name && args.name.trim() ? `Hi ${args.name},` : "Hi,";
  const html = wrapHtml(
    "Welcome to InterviewReplay",
    `<p>${greeting}</p>
     <p>You&rsquo;re all set. InterviewReplay is free to use — record as many sessions as you like.</p>
     <p>How it works:</p>
     <ol style="margin:8px 0 16px 20px;padding:0;">
       <li>Start a session right before your interview begins.</li>
       <li>We record only your microphone (never the interviewer, never the screen).</li>
       <li>The audio is transcribed locally — it never leaves your machine.</li>
       <li>Review and add any context, then get an AI-generated coaching report.</li>
     </ol>`,
    "general",
    `${APP_URL()}/sessions/new`,
    "Start your first session",
  );
  return sendEmail({
    to: args.to,
    subject: "Welcome to InterviewReplay",
    html,
    text: stripHtml(html),
    category: "general",
  });
}

export async function sendTranscriptionCompleteEmail(args: {
  to: string;
  sessionId: string;
  companyName: string;
  roleTitle: string;
}): Promise<SendEmailResult> {
  const html = wrapHtml(
    "Your transcript is ready",
    `<p>We've transcribed your <strong>${args.roleTitle}</strong> session at ${args.companyName}.</p>
     <p>Open it to review, add any context (questions, code, design notes), and submit for analysis.</p>`,
    "general",
    `${APP_URL()}/sessions/${args.sessionId}/review`,
    "Review your transcript",
  );
  return sendEmail({
    to: args.to,
    subject: "Your InterviewReplay transcript is ready",
    html,
    text: stripHtml(html),
    category: "general",
  });
}

export async function sendAccountDeletionInitiatedEmail(args: {
  to: string;
  hardDeleteAt: Date;
}): Promise<SendEmailResult> {
  const dateStr = formatDateUtc(args.hardDeleteAt);
  const html = wrapHtml(
    "Your InterviewReplay account will be deleted",
    `<p>You requested deletion of your InterviewReplay account.</p>
     <p>We'll permanently delete your account and all associated data on <strong>${dateStr}</strong> (${ACCOUNT_DELETION_GRACE_DAYS} days from now).</p>
     <p>If you change your mind, just sign back in any time before then and we'll cancel the deletion automatically.</p>
     <p>If you didn't request this, sign back in and contact us at <a href="mailto:${PRIVACY_CONTACT_EMAIL}" style="color:#2c5d63;">${PRIVACY_CONTACT_EMAIL}</a> right away.</p>`,
    "privacy",
    `${APP_URL()}/signin`,
    "Sign back in to cancel",
  );
  return sendEmail({
    to: args.to,
    subject: `Your InterviewReplay account will be deleted on ${dateStr}`,
    html,
    text: stripHtml(html),
    category: "privacy",
  });
}

export async function sendAccountDeletionFinalEmail(args: {
  to: string;
}): Promise<SendEmailResult> {
  const html = wrapHtml(
    "Your InterviewReplay account has been deleted",
    `<p>As requested, we've permanently deleted your InterviewReplay account.</p>
     <p>This includes:</p>
     <ul style="margin:8px 0 16px 20px;padding:0;">
       <li>Your profile, sign-in credentials, and email address</li>
       <li>Every interview session, transcript, and report</li>
       <li>All artifacts and notes you added</li>
     </ul>
     <p>If this was not what you wanted, contact us at <a href="mailto:${PRIVACY_CONTACT_EMAIL}" style="color:#2c5d63;">${PRIVACY_CONTACT_EMAIL}</a> — we may be able to help, but the data itself is gone.</p>
     <p>Thanks for trying InterviewReplay.</p>`,
    "privacy",
  );
  return sendEmail({
    to: args.to,
    subject: "Your InterviewReplay account has been deleted",
    html,
    text: stripHtml(html),
    category: "privacy",
  });
}

export async function sendOutcomeReminderEmail(args: {
  to: string;
  sessionId: string;
  companyName: string;
  roleTitle: string;
}): Promise<SendEmailResult> {
  // The CTA carries a UTM parameter so the analytics layer can
  // attribute the resulting page view to the email click — see
  // `outcome_reminder_clicked` in `lib/analytics/events.ts`.
  // The matching client-side capture lives in
  // `(app)/sessions/[id]/page.tsx` (it reads `searchParams` and
  // captures the event before `OutcomeCard` mounts).
  //
  // `companyName` and `roleTitle` are user-controlled strings.
  // We URL-encode them in the link (defense in depth — the URL
  // doesn't actually use them, but if it ever does, the encoding
  // is already in place) and HTML-escape them in the body and
  // subject so a candidate who put `<script>` in their company
  // name doesn't end up with a malformed mail in their own inbox
  // or upstream parser.
  const company = escapeHtml(args.companyName);
  const role = escapeHtml(args.roleTitle);
  const ctaUrl = `${APP_URL()}/sessions/${encodeURIComponent(args.sessionId)}/outcome?utm_source=interview-replay&utm_medium=email&utm_campaign=outcome_reminder`;
  const html = wrapHtml(
    `How did your ${company} interview go?`,
    `<p>It&rsquo;s been a couple of weeks since your <strong>${role}</strong> interview at ${company}.</p>
     <p>If you&rsquo;ve heard back, take 30 seconds to record the outcome. We use it to track your progress over time and to make every future report sharper.</p>
     <p>If you&rsquo;d rather not, no worries &mdash; we won&rsquo;t ask again about this one.</p>`,
    "general",
    ctaUrl,
    "Record the outcome",
  );
  return sendEmail({
    to: args.to,
    // Subjects don't render HTML, but a stray newline or angle
    // bracket can confuse upstream parsers; collapse + drop them.
    subject: `How did your ${args.companyName.replace(/[\r\n<>]/g, " ").trim()} interview go?`,
    html,
    text: stripHtml(html),
    category: "general",
  });
}

/**
 * Forward a /contact form submission to the operator inbox.
 *
 * The Reply-To header is set to the submitter's email so the operator
 * can reply directly from their inbox. The From header stays at
 * EMAIL_FROM_ADDRESS (noreply@example.com) because Resend rejects sends
 * from domains we haven't verified — using the submitter's email as
 * From would also tank deliverability via SPF/DKIM mismatch.
 *
 * Body fields are HTML-escaped before interpolation so a submitter
 * can't inject markup that confuses Gmail's renderer (or, more
 * importantly, the operator-only `Forwarded-By:` trail later if we
 * pipe these into a real ticketing system).
 */
export async function sendContactSubmissionEmail(args: {
  fromEmail: string;
  fromName: string | null;
  subject: string;
  message: string;
  /**
   * Request metadata captured at the API boundary. NOT shown in the
   * submitter-facing copy (we don't want the form to echo their IP
   * back at them); included in the operator email for abuse triage.
   */
  ipAddress: string;
  userAgent: string;
}): Promise<SendEmailResult> {
  const safeEmail = escapeHtml(args.fromEmail);
  const safeName = args.fromName ? escapeHtml(args.fromName) : null;
  const safeSubject = escapeHtml(args.subject);
  const safeMessage = escapeHtml(args.message).replace(/\n/g, "<br />");
  const safeIp = escapeHtml(args.ipAddress);
  const safeUa = escapeHtml(args.userAgent);

  // Subject prefix makes the inbox filter-friendly: a filter on
  // `[InterviewReplay contact]` can label/route every submission consistently.
  const subjectLine = `[InterviewReplay contact] ${args.subject.replace(/[\r\n]/g, " ").slice(0, 120)}`;

  const html = wrapHtml(
    `New contact submission from ${safeName ?? safeEmail}`,
    `<p style="margin:0 0 16px;color:#374151;">Subject: <strong>${safeSubject}</strong></p>
     <p style="margin:0 0 8px;color:#6b7280;font-size:12px;">From:
       ${safeName ? `${safeName} &lt;${safeEmail}&gt;` : safeEmail}
     </p>
     <div style="margin:16px 0;padding:16px;border:1px solid #e5e7eb;border-radius:8px;background:#fafafa;font-size:14px;line-height:1.6;color:#1f2937;">
       ${safeMessage}
     </div>
     <p style="margin:24px 0 0;font-size:11px;color:#9ca3af;">
       Reply directly to this email to respond to the submitter.<br />
       IP: ${safeIp} &middot; User-Agent: ${safeUa}
     </p>`,
    "general",
  );

  return sendEmail({
    // Contact form submissions go to the general support inbox. The
    // reply-to override lets the operator reply directly to the submitter
    // without copy-pasting the address out of the message body.
    to: SUPPORT_CONTACT_EMAIL,
    subject: subjectLine,
    html,
    text: `${args.subject}\n\nFrom: ${args.fromName ?? args.fromEmail} <${args.fromEmail}>\n\n${args.message}\n\n— IP: ${args.ipAddress} · UA: ${args.userAgent}`,
    category: "general",
    replyTo: args.fromEmail,
  });
}

export async function sendDataExportReadyEmail(args: {
  to: string;
  downloadUrl: string;
  expiresAt: Date;
  ttlDays: number;
}): Promise<SendEmailResult> {
  const dateStr = formatDateUtc(args.expiresAt);
  const html = wrapHtml(
    "Your data export is ready",
    `<p>We've finished bundling your InterviewReplay data into a single ZIP archive.</p>
     <p>The download link below works until <strong>${dateStr}</strong> (${args.ttlDays} days from now). After that, the archive is automatically deleted from our storage.</p>
     <p>The ZIP contains your profile, sessions, transcripts, artifacts, and reports — one JSON file per category. Audio recordings are stored locally on your machine and are not included in this export.</p>`,
    "privacy",
    args.downloadUrl,
    "Download your data",
  );
  return sendEmail({
    to: args.to,
    subject: "Your InterviewReplay data export is ready",
    html,
    text: stripHtml(html),
    category: "privacy",
  });
}

/**
 * Sent to `feedback@example.com` when a user submits feedback via the
 * in-app widget. The Reply-To is set to the submitting user's email so
 * the founder can reply directly to the user from their Zoho inbox
 * without copy-pasting the address.
 *
 * This is an internal-only email — never send it to the user.
 */
export async function sendInternalFeedbackNotificationEmail(args: {
  userEmail: string;
  userName: string | null;
  rating: number;
  message: string;
  pagePath: string | null;
  submittedAt: Date;
}): Promise<SendEmailResult> {
  const safeEmail = escapeHtml(args.userEmail);
  const safeName = args.userName ? escapeHtml(args.userName) : null;
  const safeMessage = escapeHtml(args.message).replace(/\n/g, "<br />");
  const safePage = args.pagePath ? escapeHtml(args.pagePath) : null;
  const stars = "★".repeat(args.rating) + "☆".repeat(5 - args.rating);
  const dateStr = args.submittedAt.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });

  const html = wrapHtml(
    `New feedback from ${safeName ?? safeEmail}`,
    `<p style="margin:0 0 8px;color:#6b7280;font-size:12px;">
       From: ${safeName ? `${safeName} &lt;${safeEmail}&gt;` : safeEmail}<br />
       Rating: <strong>${stars}</strong> (${args.rating}/5)<br />
       ${safePage ? `Page: <code style="font-size:11px;">${safePage}</code><br />` : ""}
       Submitted: ${dateStr} IST
     </p>
     <div style="margin:16px 0;padding:16px;border:1px solid #e5e7eb;border-radius:8px;background:#fafafa;font-size:14px;line-height:1.6;color:#1f2937;">
       ${safeMessage}
     </div>
     <p style="margin:0;font-size:11px;color:#9ca3af;">
       Reply to this email to respond directly to ${safeEmail}.
     </p>`,
    "general",
  );

  const subjectLine = `[Feedback] ${args.rating}/5 from ${args.userName ?? args.userEmail}`;

  return sendEmail({
    to: FEEDBACK_INBOX_EMAIL,
    subject: subjectLine,
    html,
    text: `${args.rating}/5 from ${args.userName ?? args.userEmail} (${args.userEmail})\n\n${args.message}\n\nPage: ${args.pagePath ?? "(unknown)"}\nSubmitted: ${dateStr} IST`,
    category: "general",
    // Reply goes directly to the user so the founder can write back
    // from their inbox without any copy-paste.
    replyTo: args.userEmail,
  });
}

/**
 * Acknowledgment sent to the user immediately after they submit
 * in-app feedback. Reply-To is set to EMAIL_REPLY_TO_FEEDBACK
 * (feedback@example.com) so any user reply lands in the same inbox
 * as the feedback notification itself.
 */
export async function sendFeedbackAcknowledgmentEmail(args: {
  to: string;
  name: string | null;
}): Promise<SendEmailResult> {
  const greeting =
    args.name && args.name.trim() ? `Hi ${escapeHtml(args.name)},` : "Hi,";

  const html = wrapHtml(
    "Thanks for your feedback",
    `<p>${greeting}</p>
     <p>Thanks for taking the time to share your thoughts about InterviewReplay. I read every piece of feedback personally — sometimes within minutes, sometimes within a few hours, but always.</p>
     <p>If your feedback was a bug report, I&rsquo;ll work on it. If it was a feature request, I&rsquo;ll add it to the list and weigh it against everything else we&rsquo;re trying to build. If it was praise, you made my day.</p>
     <p>Either way, you helped InterviewReplay get a little better today. Thank you.</p>
     <p style="margin-top:24px;">
       &mdash; Satyavrat<br />
       <!-- TODO: update signature once the founder role is public-facing -->
       Founder, InterviewReplay
     </p>`,
    "feedback_acknowledgment",
  );

  return sendEmail({
    to: args.to,
    subject: "Thanks for your feedback",
    html,
    text: stripHtml(html),
    category: "feedback_acknowledgment",
  });
}

export function sendPasswordResetEmailMessage(args: {
  to: string;
  resetUrl: string;
}): Promise<SendEmailResult> {
  const html = wrapHtml(
    "Reset your InterviewReplay password",
    `<p style="margin:0 0 12px;">We received a request to reset the password for your InterviewReplay account.</p>
     <p style="margin:0 0 12px;">Click the button below to choose a new password. This link expires in 1 hour.</p>
     <p style="margin:0;font-size:12px;color:#6b7280;">If you didn't request a password reset, you can safely ignore this email — your account hasn't been changed.</p>`,
    "general",
    args.resetUrl,
    "Reset password",
  );

  return sendEmail({
    to: args.to,
    subject: "Reset your InterviewReplay password",
    html,
    text: stripHtml(html),
    category: "general",
  });
}


export function sendVerificationEmailMessage(args: {
  to: string;
  verifyUrl: string;
}): Promise<SendEmailResult> {
  const html = wrapHtml(
    "Verify your email address",
    `<p style="margin:0 0 12px;">Thanks for signing up for InterviewReplay.</p>
     <p style="margin:0 0 12px;">Click the button below to verify your email address and finish setting up your account. This link expires in 1 hour.</p>
     <p style="margin:0;font-size:12px;color:#6b7280;">If you didn't create an InterviewReplay account, you can safely ignore this email.</p>`,
    "general",
    args.verifyUrl,
    "Verify email address",
  );

  return sendEmail({
    to: args.to,
    subject: "Verify your InterviewReplay email address",
    html,
    text: stripHtml(html),
    category: "general",
  });
}
