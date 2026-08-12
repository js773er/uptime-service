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
      body = await response.text().catch(() => undefined);
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
    isUp: probe.isUp,
  });

  if (transition === "open") {
    const incident = await openIncident({
      monitorId: monitor.monitorId,
      startedAt: now,
      statusCode: probe.statusCode,
      error: probe.error,
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
        statusCode: probe.statusCode,
        error: probe.error,
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
