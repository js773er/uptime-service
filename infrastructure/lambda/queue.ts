import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { z } from "zod";

/**
 * Message contract between the checker (producer) and the alert lambda
 * (consumer). Both sides validate against this schema, so a malformed
 * message is caught at the boundary instead of deep inside the consumer.
 */
export const incidentAlertSchema = z.object({
  incidentId: z.string().min(1),
  monitorId: z.string().min(1),
  monitorName: z.string().min(1),
  url: z.string().min(1),
  startedAt: z.string().min(1),
  statusCode: z.number().nullable(),
  error: z.string().optional(),
  alertEmail: z.email().optional(),
});

export type IncidentAlert = z.infer<typeof incidentAlertSchema>;

const sqs = new SQSClient({});

/** Push a newly opened incident onto the alert queue. */
export async function enqueueIncidentAlert(alert: IncidentAlert): Promise<void> {
  const queueUrl = process.env.ALERT_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("ALERT_QUEUE_URL is not set");
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(alert),
    }),
  );
}
