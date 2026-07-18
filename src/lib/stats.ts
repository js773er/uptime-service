import type { CheckResult } from "@/types";

/**
 * Uptime percentage over a trailing window, from raw check results.
 * Returns null when there are no checks in the window (a brand-new or
 * long-paused monitor has no meaningful uptime figure).
 */
export function computeUptimePercent(
  checks: Pick<CheckResult, "isUp" | "timestamp">[],
  windowMs: number,
  now: Date,
): number | null {
  const cutoff = now.getTime() - windowMs;
  const inWindow = checks.filter(
    (c) => new Date(c.timestamp).getTime() >= cutoff,
  );
  if (inWindow.length === 0) {
    return null;
  }

  const up = inWindow.filter((c) => c.isUp).length;
  return (up / inWindow.length) * 100;
}

/** "3d 2h", "5h 20m", "4m 10s", "45s" — for incident durations. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** "just now", "2m ago", "3h ago", "5d ago" — for "last checked". */
export function formatRelativeTime(iso: string, now: Date): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
