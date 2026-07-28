import { z } from "zod";

/**
 * URL validation with basic SSRF protection.
 *
 * A monitor URL is attacker-influenced data that our checker Lambda will
 * fetch server-side. To stop someone pointing a monitor at internal
 * infrastructure (cloud metadata endpoints, private services), we require
 * https and reject localhost + private/reserved IP ranges.
 *
 * This is a defence-in-depth check, not a complete SSRF guard — DNS can still
 * resolve a public hostname to a private address. The checker should also be
 * sandboxed by least-privilege networking/IAM (see CDK step).
 */

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }

  const [a, b] = octets;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12  -> 172.16.x.x through 172.31.x.x
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 "this host"
  if (a === 0) return true;

  return false;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
]);

/**
 * Returns an error string if the URL should be rejected, or null if it's an
 * acceptable public https URL.
 */
export function getUrlRejectionReason(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "must be a valid URL";
  }

  if (parsed.protocol !== "https:") {
    return "URL must use https";
  }

  // URL.hostname keeps the surrounding brackets on IPv6 literals
  // (e.g. "[::1]"); strip them so the checks below see the bare address.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    return "localhost is not allowed";
  }

  // IPv6 loopback / unspecified.
  if (host === "::1" || host === "::") {
    return "loopback addresses are not allowed";
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8")) {
    return "private IPv6 ranges are not allowed";
  }

  if (isPrivateIPv4(host)) {
    return "private and reserved IP ranges are not allowed";
  }

  return null;
}

/** Reusable, SSRF-aware https URL schema. */
export const monitorUrlSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const reason = getUrlRejectionReason(value);
    if (reason) {
      ctx.addIssue({ code: "custom", message: reason });
    }
  });

/** Payload accepted by POST /api/monitors. */
export const createMonitorSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(100),
  url: monitorUrlSchema,
  alertEmail: z.email("must be a valid email").optional(),
});

/** Payload accepted by PATCH /api/monitors/[id] (pause/resume). */
export const updateMonitorSchema = z.object({
  active: z.boolean(),
});

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;
