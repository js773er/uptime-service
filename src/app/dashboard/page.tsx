import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserId } from "@/lib/auth";
import { getRecentChecks } from "@/lib/checks";
import { getMonitorsByUser, MAX_MONITORS_PER_USER } from "@/lib/monitors";
import {
  CHECKS_FOR_24H,
  computeUptimePercent,
  DAY_MS,
  formatRelativeTime,
  monitorState,
  type MonitorState,
} from "@/lib/stats";
import type { CheckResult, Monitor } from "@/types";
import { AddMonitorForm } from "./add-monitor-form";
import { MonitorActions } from "./monitor-actions";

export const dynamic = "force-dynamic";

interface MonitorRow {
  monitor: Monitor;
  lastCheck: CheckResult | null;
  uptime24h: number | null;
}

const BADGES: Record<MonitorState, { label: string; className: string }> = {
  paused: { label: "Paused", className: "bg-zinc-100 text-zinc-500" },
  pending: { label: "Pending", className: "bg-amber-100 text-amber-700" },
  up: { label: "Up", className: "bg-emerald-100 text-emerald-700" },
  down: { label: "Down", className: "bg-red-100 text-red-700" },
};

export default async function DashboardPage() {
  const userId = await getUserId();
  if (!userId) {
    redirect("/sign-in");
  }

  const monitors = await getMonitorsByUser(userId);
  const now = new Date();

  const rows: MonitorRow[] = await Promise.all(
    monitors.map(async (monitor) => {
      const checks = await getRecentChecks(monitor.monitorId, CHECKS_FOR_24H);
      return {
        monitor,
        lastCheck: checks[0] ?? null,
        uptime24h: computeUptimePercent(checks, DAY_MS, now),
      };
    }),
  );

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Monitors</h1>
        <p className="text-sm text-zinc-500">
          {monitors.length}/{MAX_MONITORS_PER_USER} used
        </p>
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 text-left text-zinc-500">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Uptime (24h)</th>
              <th className="px-4 py-3 font-medium">Last checked</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-zinc-500">
                  No monitors yet — add your first one below.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const status = BADGES[monitorState(row.monitor, row.lastCheck)];
              return (
                <tr
                  key={row.monitor.monitorId}
                  className="border-b border-zinc-100 last:border-0"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/monitors/${row.monitor.monitorId}`}
                      className="font-medium hover:underline"
                    >
                      {row.monitor.name}
                    </Link>
                    <div className="text-xs text-zinc-500">{row.monitor.url}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}
                    >
                      {status.label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {row.uptime24h === null ? "—" : `${row.uptime24h.toFixed(2)}%`}
                  </td>
                  <td className="px-4 py-3 text-zinc-500">
                    {row.lastCheck
                      ? formatRelativeTime(row.lastCheck.timestamp, now)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <MonitorActions
                      monitorId={row.monitor.monitorId}
                      active={row.monitor.active}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-10 max-w-md">
        <h2 className="text-lg font-semibold">Add a monitor</h2>
        <AddMonitorForm />
      </div>
    </main>
  );
}
