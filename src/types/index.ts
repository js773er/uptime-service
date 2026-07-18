/**
 * Domain types for the uptime service.
 *
 * These mirror the DynamoDB single-table layout:
 *   Monitor:     PK USER#<userId>       SK MONITOR#<monitorId>
 *   CheckResult: PK MONITOR#<monitorId> SK CHECK#<isoTimestamp>
 *   Incident:    PK MONITOR#<monitorId> SK INCIDENT#<incidentId>
 *
 * The interfaces below describe the *domain* shape (no PK/SK). The persistence
 * layer (src/lib/*) is responsible for translating to/from table items.
 */

/** A URL the user wants us to watch. */
export interface Monitor {
  userId: string;
  monitorId: string;
  name: string;
  /** Always an https URL pointing at a public host (validated by Zod). */
  url: string;
  /** When false the checker skips this monitor (pause/resume). */
  active: boolean;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/** The outcome of a single check of a monitor's URL. */
export interface CheckResult {
  monitorId: string;
  /** ISO 8601 timestamp of when the check ran; also the sort key. */
  timestamp: string;
  /** HTTP status code, or null if the request never completed. */
  statusCode: number | null;
  /** Round-trip time in milliseconds. */
  responseTimeMs: number;
  /** True for 2xx/3xx responses. */
  isUp: boolean;
  /** Present when the check failed before/without an HTTP response. */
  error?: string;
}

/** An open or resolved period of downtime for a monitor. */
export interface Incident {
  monitorId: string;
  incidentId: string;
  /** ISO 8601 timestamp when the monitor first went down. */
  startedAt: string;
  /** ISO 8601 timestamp when it recovered; absent while ongoing. */
  resolvedAt?: string;
  /** Set when resolved: resolvedAt - startedAt, in milliseconds. */
  durationMs?: number;
  /** Status code observed when the incident opened (context for triage). */
  statusCode?: number | null;
  /** Short error string observed when the incident opened. */
  error?: string;
}
