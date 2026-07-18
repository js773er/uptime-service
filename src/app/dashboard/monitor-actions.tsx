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

  async function toggleActive() {
    setBusy(true);
    try {
      await fetch(`/api/monitors/${monitorId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !active }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this monitor and stop checking it?")) {
      return;
    }
    setBusy(true);
    try {
      await fetch(`/api/monitors/${monitorId}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const buttonClass =
    "rounded-md border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50";

  return (
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
  );
}
