import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Incident, Monitor } from "@/types";

vi.mock("@/lib/checks", () => ({ writeCheckResult: vi.fn() }));
vi.mock("@/lib/incidents", () => ({
  getOpenIncident: vi.fn(),
  openIncident: vi.fn(),
  closeIncident: vi.fn(),
}));
vi.mock("@/lib/monitors", () => ({ getActiveMonitors: vi.fn() }));
vi.mock("./queue", () => ({ enqueueIncidentAlert: vi.fn() }));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import { lookup } from "node:dns/promises";
import { writeCheckResult } from "@/lib/checks";
import { closeIncident, getOpenIncident, openIncident } from "@/lib/incidents";
import { checkMonitor, probeUrl } from "./checker";
import { enqueueIncidentAlert } from "./queue";

describe("probeUrl", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats 2xx as up", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const probe = await probeUrl("https://example.com");
    expect(probe.isUp).toBe(true);
    expect(probe.statusCode).toBe(200);
  });

  it("treats 3xx as up (redirects not followed)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 301 }),
    );

    const probe = await probeUrl("https://example.com");
    expect(probe.isUp).toBe(true);
    expect(probe.statusCode).toBe(301);
  });

  it("treats 5xx as down", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );

    const probe = await probeUrl("https://example.com");
    expect(probe.isUp).toBe(false);
    expect(probe.statusCode).toBe(503);
  });

  it("reports a timeout as down with a null status code", async () => {
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);

    const probe = await probeUrl("https://example.com", 10);
    expect(probe.isUp).toBe(false);
    expect(probe.statusCode).toBeNull();
    expect(probe.error).toBe("request timed out");
  });

  it("reports a network error as down", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ENOTFOUND"));

    const probe = await probeUrl("https://example.com");
    expect(probe.isUp).toBe(false);
    expect(probe.error).toBe("ENOTFOUND");
  });

  it("refuses to fetch a hostname that resolves to a private address", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: "10.0.0.5", family: 4 },
    ] as never);

    const probe = await probeUrl("https://rebound.example.com");
    expect(probe.isUp).toBe(false);
    expect(probe.error).toMatch(/private or reserved/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to fetch private IP literals without a DNS lookup", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const probe = await probeUrl("https://169.254.169.254");
    expect(probe.isUp).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("checkMonitor", () => {
  const monitor: Monitor = {
    userId: "u1",
    monitorId: "m1",
    name: "My site",
    url: "https://example.com",
    active: true,
    alertEmail: "owner@example.com",
    createdAt: "2026-07-01T00:00:00.000Z",
  };

  const openedIncident: Incident = {
    monitorId: "m1",
    incidentId: "inc-1",
    startedAt: "2026-07-18T00:00:00.000Z",
    statusCode: 503,
  };

  const now = "2026-07-18T00:01:00.000Z";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens an incident and enqueues one alert when a monitor goes down", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    vi.mocked(getOpenIncident).mockResolvedValue(null);
    vi.mocked(openIncident).mockResolvedValue(openedIncident);

    await checkMonitor(monitor, now);

    expect(writeCheckResult).toHaveBeenCalledOnce();
    expect(openIncident).toHaveBeenCalledOnce();
    expect(enqueueIncidentAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: "inc-1",
        monitorName: "My site",
        alertEmail: "owner@example.com",
      }),
    );
  });

  it("does not alert again while a monitor stays down", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    vi.mocked(getOpenIncident).mockResolvedValue(openedIncident);

    await checkMonitor(monitor, now);

    expect(openIncident).not.toHaveBeenCalled();
    expect(enqueueIncidentAlert).not.toHaveBeenCalled();
    expect(closeIncident).not.toHaveBeenCalled();
  });

  it("closes the incident without alerting when a monitor recovers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    vi.mocked(getOpenIncident).mockResolvedValue(openedIncident);

    await checkMonitor(monitor, now);

    expect(closeIncident).toHaveBeenCalledWith(openedIncident, now);
    expect(enqueueIncidentAlert).not.toHaveBeenCalled();
  });

  it("skips the alert when an overlapping run already opened the incident", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    vi.mocked(getOpenIncident).mockResolvedValue(null);
    vi.mocked(openIncident).mockResolvedValue(null);

    await checkMonitor(monitor, now);

    expect(writeCheckResult).toHaveBeenCalledOnce();
    expect(enqueueIncidentAlert).not.toHaveBeenCalled();
  });

  it("still records the check when the alert enqueue fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    vi.mocked(getOpenIncident).mockResolvedValue(null);
    vi.mocked(openIncident).mockResolvedValue(openedIncident);
    vi.mocked(enqueueIncidentAlert).mockRejectedValue(new Error("sqs down"));

    await expect(checkMonitor(monitor, now)).resolves.toBeUndefined();
    expect(writeCheckResult).toHaveBeenCalledOnce();
  });
});
