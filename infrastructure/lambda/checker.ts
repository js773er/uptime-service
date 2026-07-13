import { writeCheckResult } from "@/lib/checks";
import {
  closeIncident,
  getOpenIncident,
  openIncident,
} from "@/lib/incidents";
import { getActiveMonitors } from "@/lib/monitors";
import type { CheckResult, Monitor } from "@/types";
import { decideIncidentTransition } from "./incident-logic";

/** How long to wait for a monitored URL before treating it as down. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Outcome of probing a single URL (no persistence concerns). */
export interface UrlProbe {
  statusCode: number | null;
  responseTimeMs: number;
  isUp: boolean;
  error?: string;
}

/**
 * Probe a URL with a hard timeout. 2xx/3xx counts as up. Redirects are not
 * followed: it keeps 3xx as "up" and avoids a redirect being used to reach an
 * address the URL validation already rejected (SSRF defence-in-depth).
 */
export async function probeUrl(
  url: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<UrlProbe> {
  const start = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "uptime-service-checker/1.0" },
    });
    const responseTimeMs = Math.round(performance.now() - start);
    return {
      statusCode: response.status,
      responseTimeMs,
      isUp: response.status >= 200 && response.status < 400,
    };
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
 * Check one monitor: record the result, then open/close an incident if the
 * up/down state changed.
 */
export async function checkMonitor(
  monitor: Monitor,
  now: string,
): Promise<void> {
  const probe = await probeUrl(monitor.url);

  const check: CheckResult = {
    monitorId: monitor.monitorId,
    timestamp: now,
    statusCode: probe.statusCode,
    responseTimeMs: probe.responseTimeMs,
    isUp: probe.isUp,
    error: probe.error,
  };
  await writeCheckResult(check);

  const openIncidentRecord = await getOpenIncident(monitor.monitorId);
  const transition = decideIncidentTransition({
    hasOpenIncident: openIncidentRecord !== null,
    isUp: probe.isUp,
  });

  if (transition === "open") {
    await openIncident({
      monitorId: monitor.monitorId,
      startedAt: now,
      statusCode: probe.statusCode,
      error: probe.error,
    });
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

  const failed = results.filter((r) => r.status === "rejected");
  for (const failure of failed) {
    if (failure.status === "rejected") {
      console.error("monitor check failed:", failure.reason);
    }
  }

  console.log(
    `checked ${monitors.length} monitor(s), ${failed.length} failed`,
  );
}
