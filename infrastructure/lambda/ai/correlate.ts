import { z } from "zod";
import type { IncidentAlert } from "../queue";
import { askForJson } from "./client";

/**
 * Alert correlation: when several monitors fail in the same window, send one
 * email explaining the pattern instead of one email per monitor.
 *
 * Simultaneous failures usually share a cause — a provider outage, an expired
 * certificate, one host behind several names. Five separate "DOWN" emails make
 * the reader do that inference at 3am; this does it for them. Grouping alerts
 * by inferred cause is what paging tools call alert correlation.
 */

export const correlationSchema = z.object({
  subject: z.string().min(1).max(150),
  summary: z.string().min(1).max(1200),
});

export type Correlation = z.infer<typeof correlationSchema>;

const CORRELATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    subject: {
      type: "string",
      description:
        "Email subject line. State how many services are down and the shared " +
        "cause if there is one. No prefix — the sender adds it.",
    },
    summary: {
      type: "string",
      description:
        "A few plain sentences: what is down, what the failures have in " +
        "common, and the most useful thing to check first. Say plainly if " +
        "the failures look unrelated. No greeting or sign-off.",
    },
  },
  required: ["subject", "summary"],
  additionalProperties: false,
} as const;

/** Correlation only makes sense across multiple simultaneous incidents. */
export const MIN_ALERTS_TO_CORRELATE = 2;

export async function correlateAlerts(
  alerts: IncidentAlert[],
): Promise<Correlation | null> {
  if (alerts.length < MIN_ALERTS_TO_CORRELATE) {
    return null;
  }

  const lines = alerts.map((alert) => {
    const cause =
      alert.statusCode !== null
        ? `HTTP ${alert.statusCode}`
        : (alert.error ?? "no response");
    return `- ${alert.monitorName} (${alert.url}) — ${cause}, since ${alert.startedAt}`;
  });

  const prompt = [
    "Several monitored services went down at about the same time.",
    "Write one alert email covering all of them.",
    "",
    "Look for what the failures have in common — the same host or domain, the",
    "same provider or region, the same status code, the same timing. If you",
    "see a likely shared cause, lead with it. If they look unrelated, say so",
    "rather than inventing a connection.",
    "",
    "Failures:",
    ...lines,
  ].join("\n");

  return askForJson({
    prompt,
    jsonSchema: CORRELATION_JSON_SCHEMA,
    zodSchema: correlationSchema,
  });
}
