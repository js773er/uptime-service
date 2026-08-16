import { lookup } from "node:dns/promises";
import { writeCheckResult } from "@/lib/checks";
import {
  closeIncident,
  getOpenIncident,
  openIncident,
} from "@/lib/incidents";
import { getActiveMonitors, recordContentAnalysis } from "@/lib/monitors";
import { isBlockedIpAddress } from "@/lib/schemas";
import type { CheckResult, Monitor } from "@/types";
import {
  analyzeContent,
  extractText,
  hashContent,
  shouldAnalyze,
} from "./ai/content-analysis";
import { decideIncidentTransition } from "./incident-logic";
import { enqueueIncidentAlert } from "./queue";

/** How long to wait for a monitored URL before treating it as down. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Cap on bytes read for content checking. All monitors run concurrently in
 * one invocation, so an unbounded read of a large response would exhaust the
 * function's memory and take every other monitor down with it.
 */
const MAX_BODY_BYTES = 512 * 1024;

/** Only textual responses are worth analysing; a PDF or image is noise. */
const TEXTUAL_CONTENT_TYPE = /^(text\/html|text\/plain|application\/xhtml)/i;

/**
 * Read at most `MAX_BODY_BYTES` of a textual response, then cancel the
 * transfer. Returns undefined for non-textual or unreadable bodies.
 */
async function readCappedText(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!TEXTUAL_CONTENT_TYPE.test(contentType)) {
    return undefined;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return undefined;
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let bytes = 0;
  try {
    while (bytes < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  } catch {
    return undefined;
  } finally {
    // We have all we need — don't keep pulling a large body.
    await reader.cancel().catch(() => {});
  }
}

/** Outcome of probing a single URL (no persistence concerns). */
export interface UrlProbe {
  statusCode: number | null;
  responseTimeMs: number;
  isUp: boolean;
  error?: string;
  /** Response body, read only when the caller asked for it. */
  body?: string;
}

/**
 * URL validation happens at create time, but DNS can change afterwards (DNS
 * rebinding): a hostname that resolved publicly yesterday can point at a
 * private address today. Re-check every resolved address right before the
 * fetch. Resolution failures return false — the fetch reports the real error.
 */
async function resolvesToBlockedAddress(url: string): Promise<boolean> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isBlockedIpAddress(host)) {
    return true;
  }
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.some((a) => isBlockedIpAddress(a.address));
  } catch {
    return false;
  }
}

/**
 * Probe a URL with a hard timeout. 2xx/3xx counts as up. Redirects are not
 * followed: it keeps 3xx as "up" and avoids a redirect being used to reach an
 * address the URL validation already rejected (SSRF defence-in-depth).
 */
export async function probeUrl(
  url: string,
  options: { timeoutMs?: number; readBody?: boolean } = {},
): Promise<UrlProbe> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  if (await resolvesToBlockedAddress(url)) {
    return {
      statusCode: null,
      responseTimeMs: 0,
      isUp: false,
      error: "hostname resolves to a private or reserved address",
    };
  }

  const start = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "uptime-service-checker/1.0" },
    });
    const responseTimeMs = Math.round(performance.now() - start);
    const isUp = response.status >= 200 && response.status < 400;

    // Reading the body costs time and memory, so only do it when a content
    // check will actually use it.
    let body: string | undefined;
    if (options.readBody && isUp) {
      body = await readCappedText(response);
    }

    return { statusCode: response.status, responseTimeMs, isUp, body };
  } catch (err) {
    const responseTimeMs = Math.round(performance.now() - start);
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    return {
      statusCode: null,
      responseTimeMs,
      isUp: false,
      error: isTimeout
        ? "request timed out"
        : err instanceof Error
          ? err.message
          : "request failed",
    };
  }
}

/**
 * Run the semantic content check when it's enabled, the page is HTTP-healthy,
 * and the throttle allows it. Any failure degrades to "no verdict" — the HTTP
 * result still stands, so the monitor keeps working without the model.
 */
async function runContentCheck(
  monitor: Monitor,
  probe: UrlProbe,
  now: string,
): Promise<{ healthy?: boolean; reason?: string }> {
  if (!probe.body) {
    return {};
  }

  const bodyText = extractText(probe.body);
  if (!bodyText) {
    return {};
  }

  const currentHash = hashContent(bodyText);
  const analyze = shouldAnalyze({
    contentCheckEnabled: monitor.contentCheck === true,
    httpIsUp: probe.isUp,
    currentHash,
    previousHash: monitor.contentHash,
    lastAnalyzedAt: monitor.contentAnalyzedAt,
    now: new Date(now),
  });

  if (!analyze) {
    // Carry the stored verdict forward while the page is unchanged. Without
    // this a detected content outage would clear on the very next check,
    // closing the incident a minute after it opened.
    if (currentHash === monitor.contentHash && monitor.contentHealthy !== undefined) {
      return {
        healthy: monitor.contentHealthy,
        reason: monitor.contentReason,
      };
    }
    return {};
  }

  const verdict = await analyzeContent({
    monitorName: monitor.name,
    url: monitor.url,
    statusCode: probe.statusCode,
    bodyText,
  });
  if (!verdict) {
    return {};
  }

  // Best-effort bookkeeping: losing the throttle state costs an extra call
  // later, never a missed check.
  try {
    await recordContentAnalysis({
      userId: monitor.userId,
      monitorId: monitor.monitorId,
      contentHash: currentHash,
      analyzedAt: now,
      healthy: verdict.healthy,
      reason: verdict.reason,
    });
  } catch (err) {
    console.error(
      `failed to record content analysis for ${monitor.monitorId}:`,
      err,
    );
  }

  return { healthy: verdict.healthy, reason: verdict.reason };
}

/**
 * Check one monitor: record the result, then open/close an incident if the
 * up/down state changed.
 */
export async function checkMonitor(
  monitor: Monitor,
  now: string,
): Promise<void> {
  const contentCheckEnabled = monitor.contentCheck === true;
  const probe = await probeUrl(monitor.url, { readBody: contentCheckEnabled });

  const content = await runContentCheck(monitor, probe, now);

  // A page that answers 200 with an error inside it is down from the user's
  // point of view, so the content verdict can override the HTTP verdict.
  const isUp = probe.isUp && content.healthy !== false;

  const check: CheckResult = {
    monitorId: monitor.monitorId,
    timestamp: now,
    statusCode: probe.statusCode,
    responseTimeMs: probe.responseTimeMs,
    isUp,
    error: probe.error ?? (content.healthy === false ? content.reason : undefined),
    contentHealthy: content.healthy,
    contentReason: content.reason,
  };
  await writeCheckResult(check);

  const openIncidentRecord = await getOpenIncident(monitor.monitorId);
  const transition = decideIncidentTransition({
    hasOpenIncident: openIncidentRecord !== null,
    // The merged verdict, not the raw HTTP one — otherwise a content failure
    // records a down check but never opens an incident or alerts.
    isUp,
  });

  if (transition === "open") {
    // A content failure answers 200, so reporting the status code would read
    // as "[DOWN] … (HTTP 200)". Report the content reason instead, and drop
    // the status code so it can't mask the real cause.
    const contentFailed = probe.isUp && content.healthy === false;
    const causeStatusCode = contentFailed ? null : probe.statusCode;
    const causeError = contentFailed ? content.reason : probe.error;

    const incident = await openIncident({
      monitorId: monitor.monitorId,
      startedAt: now,
      statusCode: causeStatusCode,
      error: causeError,
    });
    // Null means an overlapping run opened it first — that run alerts.
    if (!incident) {
      return;
    }

    // Alert only on the up->down edge, never on every failing check.
    // Best-effort: a queue hiccup must not fail the check itself — the
    // incident is already recorded either way.
    try {
      await enqueueIncidentAlert({
        incidentId: incident.incidentId,
        monitorId: monitor.monitorId,
        monitorName: monitor.name,
        url: monitor.url,
        startedAt: now,
        statusCode: causeStatusCode,
        error: causeError,
        alertEmail: monitor.alertEmail,
      });
    } catch (err) {
      console.error(
        `failed to enqueue alert for incident ${incident.incidentId}:`,
        err,
      );
    }
  } else if (transition === "close" && openIncidentRecord) {
    await closeIncident(openIncidentRecord, now);
  }
}

/**
 * EventBridge-triggered entry point. Runs every active monitor concurrently;
 * one monitor failing never aborts the others.
 */
export async function handler(): Promise<void> {
  const monitors = await getActiveMonitors();
  const now = new Date().toISOString();

  const results = await Promise.allSettled(
    monitors.map((monitor) => checkMonitor(monitor, now)),
  );

  let failed = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      failed += 1;
      console.error("monitor check failed:", result.reason);
    }
  }

  console.log(`checked ${monitors.length} monitor(s), ${failed} failed`);
}
