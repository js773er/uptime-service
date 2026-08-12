import { createHash } from "node:crypto";
import { z } from "zod";
import { askForJson } from "./client";

/**
 * Semantic content checking: catch pages that answer 200 but render an error,
 * a maintenance notice, or an empty shell.
 *
 * A keyword check can't do this — it requires knowing in advance which string
 * to look for, and nobody predicts the wording of a failure they haven't had
 * yet. Judging "does this look like a working page" is the one part of the
 * system where a language model is the right tool rather than a bolted-on one.
 */

/** Body text sent to the model. Enough to judge, small enough to stay cheap. */
const MAX_BODY_CHARS = 4000;

/** Never analyse the same monitor more often than this. */
export const ANALYSIS_THROTTLE_MS = 60 * 60 * 1000;

export const contentVerdictSchema = z.object({
  healthy: z.boolean(),
  reason: z.string().min(1).max(300),
});

export type ContentVerdict = z.infer<typeof contentVerdictSchema>;

const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    healthy: {
      type: "boolean",
      description:
        "true if this looks like the working product page it should be; " +
        "false if it is an error page, maintenance notice, or empty shell.",
    },
    reason: {
      type: "string",
      description:
        "One short sentence of evidence for the verdict, quoting the page " +
        "where useful. Written for the site owner.",
    },
  },
  required: ["healthy", "reason"],
  additionalProperties: false,
} as const;

/** Stable fingerprint of page content, used to avoid re-analysing what hasn't changed. */
export function hashContent(body: string): string {
  return createHash("sha256").update(body.trim()).digest("hex").slice(0, 32);
}

/**
 * Decide whether to spend an API call on this check — pure, so the cost policy
 * is unit-testable without mocking the model.
 *
 * Analyse only when the page is HTTP-healthy (a 500 is already known to be
 * down), and only when the content actually changed, subject to a throttle.
 * In the steady state a monitor whose page is unchanged costs nothing.
 */
export function shouldAnalyze(state: {
  contentCheckEnabled: boolean;
  httpIsUp: boolean;
  currentHash: string;
  previousHash?: string;
  lastAnalyzedAt?: string;
  now: Date;
}): boolean {
  if (!state.contentCheckEnabled || !state.httpIsUp) {
    return false;
  }
  // Never analysed before: always take the first look.
  if (!state.previousHash || !state.lastAnalyzedAt) {
    return true;
  }
  if (state.currentHash === state.previousHash) {
    return false;
  }
  const elapsed = state.now.getTime() - new Date(state.lastAnalyzedAt).getTime();
  return elapsed >= ANALYSIS_THROTTLE_MS;
}

/** Strip markup so the model reads text, not a wall of attributes. */
export function extractText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BODY_CHARS);
}

/** Ask the model whether a page that returned 2xx is actually working. */
export async function analyzeContent(input: {
  monitorName: string;
  url: string;
  statusCode: number | null;
  bodyText: string;
}): Promise<ContentVerdict | null> {
  const prompt = [
    "You are checking whether a monitored web page is actually working.",
    "",
    `Monitor: ${input.monitorName}`,
    `URL: ${input.url}`,
    `HTTP status: ${input.statusCode ?? "unknown"}`,
    "",
    "The server returned a success status, so the question is not whether it",
    "responded — it is whether the page a visitor sees is the working product.",
    "",
    "Treat as NOT healthy: error messages or stack traces, maintenance or",
    '"be right back" notices, a page that is blank or has no real content,',
    "and access-denied or rate-limit pages.",
    "",
    "Treat as healthy: normal product, marketing, docs, or app pages — even if",
    "content is sparse, unfamiliar, or not in English.",
    "",
    "Page text follows.",
    "---",
    input.bodyText,
  ].join("\n");

  return askForJson({
    prompt,
    jsonSchema: VERDICT_JSON_SCHEMA,
    zodSchema: contentVerdictSchema,
  });
}
