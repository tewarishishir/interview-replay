import "server-only";

/**
 * Email transport using nodemailer (SMTP). Falls back to console
 * logging when SMTP is not configured — making email entirely
 * optional for self-hosted deployments.
 *
 * Env vars:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */

export type EmailCategory =
  | "general"
  | "privacy"
  | "feedback_acknowledgment"
  | "founders";

function getReplyTo(category: EmailCategory): string {
  switch (category) {
    case "general":
      return process.env.EMAIL_REPLY_TO_GENERAL ?? "";
    case "privacy":
      return process.env.EMAIL_REPLY_TO_PRIVACY ?? "";
    case "feedback_acknowledgment":
      return process.env.EMAIL_REPLY_TO_FOUNDERS ?? "";
    case "founders":
      return process.env.EMAIL_REPLY_TO_FOUNDERS ?? "";
  }
}

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
  category: EmailCategory;
  replyTo?: string;
}

export interface SendEmailResult {
  dispatched: boolean;
  id?: string;
}

let transporter: any = null;

async function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port) return null;

  try {
    const nodemailer = await import("nodemailer");
    transporter = nodemailer.default.createTransport({
      host,
      port: parseInt(port, 10),
      secure: parseInt(port, 10) === 465,
      auth: user && pass ? { user, pass } : undefined,
    });
    return transporter;
  } catch {
    return null;
  }
}

export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const smtp = await getTransporter();
  const from = process.env.SMTP_FROM ?? "noreply@localhost";

  if (!smtp) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        `[email] SMTP not configured. Would have sent:\n` +
          `  to: ${args.to}\n` +
          `  subject: ${args.subject}\n` +
          `  from: ${from}`,
      );
    }
    return { dispatched: false };
  }

  const replyTo = args.replyTo ?? getReplyTo(args.category);

  try {
    const info = await smtp.sendMail({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      replyTo: replyTo || undefined,
    });
    return { dispatched: true, id: info.messageId };
  } catch (err) {
    console.error("[email] SMTP dispatch failed:", err);
    return { dispatched: false };
  }
}
