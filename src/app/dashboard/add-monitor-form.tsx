"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createMonitorSchema } from "@/lib/schemas";

/**
 * Client-side validation runs the same Zod schema the API uses, so the form
 * can never disagree with the server about what a valid monitor is.
 */
export function AddMonitorForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = event.currentTarget;
    const data = new FormData(form);
    const alertEmail = String(data.get("alertEmail") ?? "").trim();

    const parsed = createMonitorSchema.safeParse({
      name: String(data.get("name") ?? ""),
      url: String(data.get("url") ?? ""),
      ...(alertEmail ? { alertEmail } : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "invalid input");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/monitors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          issues?: string[];
        } | null;
        setError(body?.issues?.[0] ?? body?.error ?? `request failed (${res.status})`);
        return;
      }

      form.reset();
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm " +
    "focus:border-zinc-500 focus:outline-none";

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-3">
      <input name="name" placeholder="Name (e.g. Marketing site)" className={inputClass} />
      <input name="url" placeholder="https://example.com" className={inputClass} />
      <input
        name="alertEmail"
        placeholder="Alert email (optional — defaults to your account email)"
        className={inputClass}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
      >
        {submitting ? "Adding…" : "Add monitor"}
      </button>
    </form>
  );
}
