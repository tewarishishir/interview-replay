import "server-only";

import { sendEmail, type SendEmailResult } from "./client";
import { env } from "@/lib/env";

/**
 * Send an internal ops alert email to the ALERT_TO_EMAIL address.
 *
 * Call this for failures that require immediate human attention:
 * background job failures, payment anomalies, health-check
 * degradation, security events (hash mismatches, chargebacks), etc.
 *
 * Design principles that match the rest of the email layer:
 *   - NEVER throws. A crashing alert is worse than a dropped one.
 *   - Falls back to stderr when ALERT_TO_EMAIL or Resend is not
 *     configured, so local dev / CI don't need a real email setup.
 *   - Emits a [ALERT] subject prefix for easy inbox filtering.
 *
 * The email is intentionally visually distinct (red banner) so it
 * stands out from transactional mail in the same inbox.
 */
export async function sendAlertEmail(args: {
  /**
   * Short subject appended after the "[ALERT]" prefix.
   * Keep it under ~60 chars so it renders untruncated in
   * most email clients.
   */
  subject: string;
  /** H1-level headline rendered at the top of the card. */
  headline: string;
  /**
   * Main body HTML. Use plain prose — the wrapper already provides
   * the structural chrome. Escape any untrusted strings before
   * passing them here.
   */
  body: string;
  /**
   * Optional key-value pairs rendered as a monospaced detail table
   * below the body. Useful for run IDs, error messages, txn IDs, etc.
   * Undefined values are silently skipped.
   */
  details?: Record<string, string | number | boolean | null | undefined>;
}): Promise<SendEmailResult> {
  const alertTo = env.ALERT_TO_EMAIL;

  if (!alertTo) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        `[alert] ALERT_TO_EMAIL not configured — would have sent:\n` +
          `  subject: ${args.subject}\n` +
          `  headline: ${args.headline}`,
      );
    }
    return { dispatched: false };
  }

  const environmentLabel =
    env.APP_ENV === "staging"
      ? "staging"
      : env.NODE_ENV === "production"
        ? "production"
        : env.NODE_ENV;

  const timestamp = new Date().toISOString();

  const detailsHtml = args.details
    ? `<table style="width:100%;border-collapse:collapse;margin:16px 0 0;font-size:13px;">
         ${Object.entries(args.details)
           .filter(([, v]) => v !== undefined)
           .map(
             ([k, v]) =>
               `<tr>
                  <td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top;">${escHtml(k)}</td>
                  <td style="padding:4px 0;color:#1f2937;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;">${escHtml(String(v ?? ""))}</td>
                </tr>`,
           )
           .join("")}
       </table>`
    : "";

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f7f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;">
    <div style="max-width:600px;margin:0 auto;background:#fff;border:2px solid #ef4444;border-radius:12px;overflow:hidden;">
      <div style="background:#ef4444;padding:10px 24px;display:flex;justify-content:space-between;align-items:center;">
        <p style="margin:0;font-size:12px;font-weight:700;color:#fff;letter-spacing:0.08em;">IR ALERT &bull; ${escHtml(environmentLabel.toUpperCase())}</p>
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.8);">${timestamp}</p>
      </div>
      <div style="padding:24px;">
        <h1 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#1f2937;letter-spacing:-0.01em;">${escHtml(args.headline)}</h1>
        <div style="font-size:14px;line-height:1.6;color:#374151;">${args.body}</div>
        ${detailsHtml}
        <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;">
          This is an automated alert from InterviewReplay. No reply needed.
        </p>
      </div>
    </div>
  </body>
</html>`;

  const text =
    `[IR ALERT — ${environmentLabel.toUpperCase()}]\n\n` +
    `${args.headline}\n\n` +
    `${args.body.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()}\n\n` +
    (args.details
      ? Object.entries(args.details)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}: ${v ?? ""}`)
          .join("\n") + "\n\n"
      : "") +
    `Time: ${timestamp}`;

  try {
    return await sendEmail({
      to: alertTo,
      subject: `[ALERT] ${args.subject}`,
      html,
      text,
      // Alerts reply to the founders inbox — any human follow-up goes
      // to the same place. We don't want replies going to the no-reply
      // address.
      category: "founders",
    });
  } catch (err) {
    console.error("[alert] sendAlertEmail dispatch failed:", err);
    return { dispatched: false };
  }
}

const escHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
