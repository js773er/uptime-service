"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function MonitorActions({
  monitorId,
  active,
}: {
  monitorId: string;
  active: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Run a mutation, surface any failure, refresh the server data on success. */
  async function run(action: () => Promise<Response>) {
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? `failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("network error");
    } finally {
      setBusy(false);
    }
  }

  function toggleActive() {
    void run(() =>
      fetch(`/api/monitors/${monitorId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !active }),
      }),
    );
  }

  function remove() {
    if (!window.confirm("Delete this monitor and stop checking it?")) {
      return;
    }
    void run(() => fetch(`/api/monitors/${monitorId}`, { method: "DELETE" }));
  }

  const buttonClass =
    "rounded-md border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50";

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex justify-end gap-2">
        <button type="button" onClick={toggleActive} disabled={busy} className={buttonClass}>
          {active ? "Pause" : "Resume"}
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className={`${buttonClass} text-red-600`}
        >
          Delete
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
