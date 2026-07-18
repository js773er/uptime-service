import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { Resend } from "resend";
import { incidentAlertSchema, type IncidentAlert } from "./queue";

/**
 * SQS consumer: turns incident messages into downtime emails via Resend.
 *
 * Uses partial batch responses: only failed messages are retried, and after
 * maxReceiveCount attempts SQS moves them to the dead-letter queue. Messages
 * that fail validation are also failed (not skipped) so poison messages end
 * up in the DLQ where they are visible, instead of vanishing silently.
 */

let resendClient: Resend | null = null;

/** Lazy so importing the module (e.g. in tests) never requires the API key. */
function getResend(): Resend {
  if (!resendClient) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error("RESEND_API_KEY is not set");
    }
    resendClient = new Resend(apiKey);
  }
  return resendClient;
}

/** Pure formatting, exported for tests. */
export function formatAlertEmail(alert: IncidentAlert): {
  subject: string;
  text: string;
} {
  const reason =
    alert.statusCode !== null
      ? `HTTP ${alert.statusCode}`
      : (alert.error ?? "no response");

  return {
    subject: `[DOWN] ${alert.monitorName} (${reason})`,
    text: [
      `${alert.monitorName} appears to be down.`,
      "",
      `URL:        ${alert.url}`,
      `Since:      ${alert.startedAt}`,
      `Reason:     ${reason}`,
      `Incident:   ${alert.incidentId}`,
      "",
      "You will not receive further emails for this incident.",
    ].join("\n"),
  };
}

async function processRecord(record: SQSRecord): Promise<void> {
  const alert = incidentAlertSchema.parse(JSON.parse(record.body));

  const to = alert.alertEmail ?? process.env.ALERT_FALLBACK_EMAIL;
  if (!to) {
    throw new Error(
      "no recipient: monitor has no alertEmail and ALERT_FALLBACK_EMAIL is not set",
    );
  }

  const from = process.env.ALERT_FROM_EMAIL ?? "Uptime <onboarding@resend.dev>";
  const { subject, text } = formatAlertEmail(alert);

  // The Resend SDK reports failures via the `error` field rather than
  // throwing, so surface it as an exception to trigger the SQS retry path.
  const { error } = await getResend().emails.send({ from, to, subject, text });
  if (error) {
    throw new Error(`resend send failed: ${error.message}`);
  }
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      console.error(`alert failed for message ${record.messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
