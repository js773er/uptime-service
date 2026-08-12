import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { Resend } from "resend";
import { formatIncidentCause } from "@/lib/stats";
import {
  correlateAlerts,
  MIN_ALERTS_TO_CORRELATE,
  type Correlation,
} from "./ai/correlate";
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
  const reason = formatIncidentCause(alert.statusCode, alert.error);

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

/** Body for a correlated alert: the model's summary, then the raw facts. */
export function formatCorrelatedEmail(
  correlation: Correlation,
  alerts: IncidentAlert[],
): string {
  const lines = alerts.map((alert) => {
    const reason = formatIncidentCause(alert.statusCode, alert.error);
    return `  ${alert.monitorName} — ${reason}\n    ${alert.url}`;
  });

  return [
    correlation.summary,
    "",
    `Affected (${alerts.length}):`,
    ...lines,
    "",
    "You will not receive further emails for these incidents.",
  ].join("\n");
}

/** Resolve the recipient for an alert, or throw with an actionable message. */
function resolveRecipient(alert: IncidentAlert): string {
  // `||`, not `??`: the CDK stack injects unset vars as empty strings, and
  // an empty string must still fall through to the defaults.
  const to = alert.alertEmail || process.env.ALERT_FALLBACK_EMAIL;
  if (!to) {
    throw new Error(
      "no recipient: monitor has no alertEmail and ALERT_FALLBACK_EMAIL is not set",
    );
  }
  return to;
}

async function send(to: string, subject: string, text: string): Promise<void> {
  const from = process.env.ALERT_FROM_EMAIL || "Uptime <onboarding@resend.dev>";

  // The Resend SDK reports failures via the `error` field rather than
  // throwing, so surface it as an exception to trigger the SQS retry path.
  const { error } = await getResend().emails.send({ from, to, subject, text });
  if (error) {
    throw new Error(`resend send failed: ${error.message}`);
  }
}

/** One email per incident — the path when nothing else failed alongside it. */
async function sendIndividually(
  parsed: { messageId: string; alert: IncidentAlert }[],
  batchItemFailures: SQSBatchResponse["batchItemFailures"],
): Promise<void> {
  for (const { messageId, alert } of parsed) {
    try {
      const { subject, text } = formatAlertEmail(alert);
      await send(resolveRecipient(alert), subject, text);
    } catch (err) {
      console.error(`alert failed for message ${messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: messageId });
    }
  }
}

/**
 * SQS consumer.
 *
 * When a batch carries several incidents that share a recipient, they are
 * correlated into one email instead of one per monitor — simultaneous
 * failures usually have one cause, and five separate pages at 3am is how
 * people learn to ignore alerts. Correlation is best-effort: if it fails,
 * every incident still gets its own email.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  const parsed: { messageId: string; alert: IncidentAlert }[] = [];

  for (const record of event.Records) {
    try {
      parsed.push({
        messageId: record.messageId,
        alert: incidentAlertSchema.parse(JSON.parse(record.body)),
      });
    } catch (err) {
      // Poison message: fail it so it reaches the DLQ rather than vanishing.
      console.error(`invalid alert message ${record.messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  // Group by recipient — correlating across tenants would leak one user's
  // monitors into another's email.
  const byRecipient = new Map<
    string,
    { messageId: string; alert: IncidentAlert }[]
  >();
  for (const entry of parsed) {
    let recipient: string;
    try {
      recipient = resolveRecipient(entry.alert);
    } catch (err) {
      console.error(`alert failed for message ${entry.messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: entry.messageId });
      continue;
    }
    const group = byRecipient.get(recipient) ?? [];
    group.push(entry);
    byRecipient.set(recipient, group);
  }

  for (const [recipient, group] of byRecipient) {
    if (group.length < MIN_ALERTS_TO_CORRELATE) {
      await sendIndividually(group, batchItemFailures);
      continue;
    }

    const correlation = await correlateAlerts(group.map((g) => g.alert));
    if (!correlation) {
      await sendIndividually(group, batchItemFailures);
      continue;
    }

    try {
      await send(
        recipient,
        `[DOWN] ${correlation.subject}`,
        formatCorrelatedEmail(correlation, group.map((g) => g.alert)),
      );
    } catch (err) {
      // The combined send covers every incident in the group, so all of them
      // retry together.
      console.error(`correlated alert failed for ${recipient}:`, err);
      for (const { messageId } of group) {
        batchItemFailures.push({ itemIdentifier: messageId });
      }
    }
  }

  return { batchItemFailures };
}
