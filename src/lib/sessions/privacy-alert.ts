import "server-only";

import { sendAlertEmail } from "@/lib/email/alerts";
import { env, features, isProduction } from "@/lib/env";

/**
 * Fire a privacy-SLA breach alert. Non-blocking by design: this
 * runs inside the privacy-SLA cron and we don't want a Slack outage to
 * mask the actual SLA breach in the function output. So we POST,
 * await the response, but never throw on failure — we log loudly
 * and return.
 *
 * The body shape is intentionally generic JSON ({title, summary,
 * details}) so it slots into:
 *   - Slack incoming webhooks (which interpret `text` if present
 *     OR fall back to ignoring the rest),
 *   - PagerDuty Events v2 (which only cares about `payload.summary`),
 *   - any "POST and read in your logs" sink.
 *
 * For Slack-shaped sinks we ALSO add a top-level `text` field so the
 * channel notification reads usefully without further configuration.
 */

export interface PrivacyAlertInput {
  breachCount: number;
  oldestScheduledDeletionAt: Date | null;
  /**
   * Limit the row identifiers we include in the body — operators
   * only need a handful to start tracing; dumping thousands of UUIDs
   * into a Slack message would just get truncated by the channel.
   */
  sampleAudioFileIds: string[];
}

export async function sendPrivacySlaAlert(
  input: PrivacyAlertInput,
): Promise<void> {
  const summary =
    `InterviewReplay privacy SLA breach: ${input.breachCount} audio file(s) ` +
    `past their 60s deletion deadline by more than 1 hour.`;

  const body = {
    text: summary,
    title: "Privacy SLA breach",
    summary,
    payload: {
      summary,
      severity: "critical",
      source: "ir-cron-enforce-audio-deletion-sla",
      custom_details: {
        breach_count: input.breachCount,
        oldest_scheduled_deletion_at:
          input.oldestScheduledDeletionAt?.toISOString() ?? null,
        sample_audio_file_ids: input.sampleAudioFileIds.slice(0, 25),
        environment: process.env.NODE_ENV,
      },
    },
  };

  if (!features.privacySlaWebhook) {
    // Always at least surface to stderr; in dev we tolerate this,
    // in production it's the operator's job to wire the webhook.
    const fn = isProduction ? console.error : console.warn;
    fn("[privacy-sla] breach detected (no webhook configured):", body);
  }

  // Send an ops alert email regardless of whether the webhook is
  // configured — this is a CRITICAL privacy commitment breach.
  await sendAlertEmail({
    subject: `Privacy SLA breach: ${input.breachCount} audio file(s) overdue`,
    headline: `Privacy SLA breach — ${input.breachCount} audio file(s) not deleted within 60s`,
    body: `<p>InterviewReplay's 60-second audio deletion promise was violated. The following audio files were still present on disk <strong>more than 1 hour</strong> after their scheduled deletion time.</p>
           <p>The SLA enforcement cron will attempt to clean these up. You should verify that the cleanup succeeded and investigate why the primary <code>delete-audio</code> worker failed to run on schedule.</p>`,
    details: {
      breach_count: input.breachCount,
      oldest_scheduled_deletion:
        input.oldestScheduledDeletionAt?.toISOString() ?? "(unknown)",
      sample_audio_file_ids: input.sampleAudioFileIds.slice(0, 10).join(", "),
    },
  }).catch((err) => {
    console.error("[privacy-sla] alert email failed:", err);
  });

  if (!features.privacySlaWebhook) return;

  try {
    const url = env.PRIVACY_SLA_ALERT_WEBHOOK_URL!;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Long-running cron — bound this so a stuck Slack/PagerDuty
      // doesn't drag the cron's wall time out indefinitely.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(
        `[privacy-sla] webhook responded ${response.status}; payload:`,
        body,
      );
    }
  } catch (err) {
    console.error("[privacy-sla] webhook POST failed:", err, "payload:", body);
  }
}
