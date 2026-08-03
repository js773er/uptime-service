import { notFound } from "next/navigation";
import { getRecentChecks } from "@/lib/checks";
import { getIncidentsByMonitor } from "@/lib/incidents";
import { getMonitorByPublicId } from "@/lib/monitors";
import {
  computeUptimePercent,
  formatDuration,
  formatRelativeTime,
} from "@/lib/stats";

const CHECKS_FOR_24H = 1500;
const DAY_MS = 24 * 60 * 60 * 1000;

export const dynamic = "force-dynamic";

/**
 * Public, read-only status page — the QR-code / share-link target.
 * Deliberately shows the monitor's name but not its URL.
 */
export default async function StatusPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const monitor = await getMonitorByPublicId(id);
  if (!monitor) {
    notFound();
  }

  const [checks, incidents] = await Promise.all([
    getRecentChecks(id, CHECKS_FOR_24H),
    getIncidentsByMonitor(id, 10),
  ]);

  const now = new Date();
  const uptime = computeUptimePercent(checks, DAY_MS, now);
  const lastCheck = checks[0] ?? null;

  const state = !monitor.active
    ? {
        label: "Monitoring paused",
        className: "bg-zinc-100 text-zinc-600",
      }
    : lastCheck === null
      ? { label: "Awaiting first check", className: "bg-amber-50 text-amber-700" }
      : lastCheck.isUp
        ? { label: "Operational", className: "bg-emerald-50 text-emerald-700" }
        : { label: "Down", className: "bg-red-50 text-red-700" };

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-14">
      <p className="text-sm text-zinc-500">Status</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">{monitor.name}</h1>

      <div className={`mt-6 rounded-lg px-5 py-4 ${state.className}`}>
        <p className="text-lg font-semibold">{state.label}</p>
        {lastCheck && (
          <p className="mt-0.5 text-sm opacity-80">
            last checked {formatRelativeTime(lastCheck.timestamp, now)}
          </p>
        )}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-zinc-200 bg-white px-5 py-4">
          <p className="text-sm text-zinc-500">Uptime (24h)</p>
          <p className="mt-1 text-2xl font-semibold">
            {uptime === null ? "—" : `${uptime.toFixed(2)}%`}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white px-5 py-4">
          <p className="text-sm text-zinc-500">Incidents (recent)</p>
          <p className="mt-1 text-2xl font-semibold">{incidents.length}</p>
        </div>
      </div>

      <section className="mt-10">
        <h2 className="font-semibold">Recent incidents</h2>
        {incidents.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">
            No incidents recorded recently.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {incidents.map((incident) => (
              <li
                key={incident.incidentId}
                className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm"
              >
                <span>
                  {new Date(incident.startedAt).toLocaleString("en-AU")}
                </span>
                <span className="text-zinc-500">
                  {incident.resolvedAt && incident.durationMs !== undefined
                    ? `resolved after ${formatDuration(incident.durationMs)}`
                    : "ongoing"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
