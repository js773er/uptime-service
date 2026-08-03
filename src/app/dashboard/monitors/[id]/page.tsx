import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getUserId } from "@/lib/auth";
import { getRecentChecks } from "@/lib/checks";
import { getIncidentsByMonitor } from "@/lib/incidents";
import { getMonitorById } from "@/lib/monitors";
import {
  computeUptimePercent,
  formatDuration,
  formatRelativeTime,
} from "@/lib/stats";
import { ResponseTimeChart, type ChartPoint } from "./response-time-chart";

const CHECKS_FOR_24H = 1500;
const DAY_MS = 24 * 60 * 60 * 1000;

export const dynamic = "force-dynamic";

export default async function MonitorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getUserId();
  if (!userId) {
    redirect("/sign-in");
  }

  const { id } = await params;
  const monitor = await getMonitorById(userId, id);
  if (!monitor) {
    notFound();
  }

  const [checks, incidents] = await Promise.all([
    getRecentChecks(id, CHECKS_FOR_24H),
    getIncidentsByMonitor(id),
  ]);

  const now = new Date();
  const uptime = computeUptimePercent(checks, DAY_MS, now);
  const lastCheck = checks[0] ?? null;

  // Oldest -> newest for the chart; failed checks become gaps in the line.
  const chartData: ChartPoint[] = [...checks].reverse().map((c) => ({
    time: new Date(c.timestamp).toLocaleTimeString("en-AU", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
    responseTimeMs: c.isUp ? c.responseTimeMs : null,
  }));

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">
      <Link href="/dashboard" className="text-sm text-zinc-500 hover:underline">
        ← Monitors
      </Link>

      <div className="mt-2 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{monitor.name}</h1>
          <p className="text-sm text-zinc-500">{monitor.url}</p>
          <Link
            href={`/status/${monitor.monitorId}`}
            className="text-sm text-blue-600 hover:underline"
          >
            Public status page →
          </Link>
        </div>
        <div className="text-right text-sm">
          <p className="text-zinc-500">Uptime (24h)</p>
          <p className="text-xl font-semibold">
            {uptime === null ? "—" : `${uptime.toFixed(2)}%`}
          </p>
        </div>
      </div>

      <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold">Response time (24h)</h2>
          {lastCheck && (
            <p className="text-xs text-zinc-500">
              last check {formatRelativeTime(lastCheck.timestamp, now)}
              {lastCheck.statusCode !== null && ` · HTTP ${lastCheck.statusCode}`}
            </p>
          )}
        </div>
        <div className="mt-4">
          <ResponseTimeChart data={chartData} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-semibold">Incident history</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 text-left text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-medium">Started</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium">Cause</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {incidents.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-zinc-500">
                    No incidents — nice and boring.
                  </td>
                </tr>
              )}
              {incidents.map((incident) => (
                <tr
                  key={incident.incidentId}
                  className="border-b border-zinc-100 last:border-0"
                >
                  <td className="px-4 py-3">
                    {new Date(incident.startedAt).toLocaleString("en-AU")}
                  </td>
                  <td className="px-4 py-3">
                    {incident.durationMs !== undefined
                      ? formatDuration(incident.durationMs)
                      : "ongoing"}
                  </td>
                  <td className="px-4 py-3 text-zinc-500">
                    {incident.statusCode !== null &&
                    incident.statusCode !== undefined
                      ? `HTTP ${incident.statusCode}`
                      : (incident.error ?? "no response")}
                  </td>
                  <td className="px-4 py-3">
                    {incident.resolvedAt ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        Resolved
                      </span>
                    ) : (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                        Open
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
