import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Incident, Monitor } from "@/types";

vi.mock("@/lib/checks", () => ({ writeCheckResult: vi.fn() }));
vi.mock("@/lib/incidents", () => ({
  getOpenIncident: vi.fn(),
  openIncident: vi.fn(),
  closeIncident: vi.fn(),
}));
vi.mock("@/lib/monitors", () => ({
  getActiveMonitors: vi.fn(),
  recordContentAnalysis: vi.fn(),
}));
vi.mock("./ai/content-analysis", async (importOriginal) => ({
  // Keep the real hashing/throttling logic; stub only the model call.
  ...(await importOriginal<typeof import("./ai/content-analysis")>()),
  analyzeContent: vi.fn(),
}));
vi.mock("./queue", () => ({ enqueueIncidentAlert: vi.fn() }));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import { lookup } from "node:dns/promises";
import { writeCheckResult } from "@/lib/checks";
import { closeIncident, getOpenIncident, openIncident } from "@/lib/incidents";
import { analyzeContent, hashContent } from "./ai/content-analysis";
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

    const probe = await probeUrl("https://example.com", { timeoutMs: 10 });
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

describe("content checking", () => {
  const brokenPage = "<html><body><h1>Application Error</h1></body></html>";
  const brokenText = "Application Error";

  /** A 200 response carrying HTML, so the body is actually read. */
  const htmlResponse = (body: string) =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  const contentMonitor: Monitor = {
    userId: "u1",
    monitorId: "m1",
    name: "Shop",
    url: "https://shop.example.com",
    active: true,
    contentCheck: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  };

  const now = "2026-08-13T00:00:00.000Z";

  const contentIncident: Incident = {
    monitorId: "m1",
    incidentId: "inc-content",
    startedAt: now,
    statusCode: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOpenIncident).mockResolvedValue(null);
    vi.mocked(openIncident).mockResolvedValue(contentIncident);
  });

  it("marks a 200 page down when the content is judged broken", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse(brokenPage));
    vi.mocked(analyzeContent).mockResolvedValue({
      healthy: false,
      reason: "Page shows an application error instead of the storefront.",
    });

    await checkMonitor(contentMonitor, now);

    expect(writeCheckResult).toHaveBeenCalledWith(
      expect.objectContaining({ isUp: false, contentHealthy: false }),
    );
  });

  it("reports the content reason, not HTTP 200, as the incident cause", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse(brokenPage));
    vi.mocked(analyzeContent).mockResolvedValue({
      healthy: false,
      reason: "Page shows an application error instead of the storefront.",
    });

    await checkMonitor(contentMonitor, now);

    // A 200 in the cause would render as "[DOWN] Shop (HTTP 200)".
    expect(openIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: null,
        error: "Page shows an application error instead of the storefront.",
      }),
    );
    expect(enqueueIncidentAlert).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: null }),
    );
  });

  it("keeps a broken page down on later checks without re-analysing it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse(brokenPage));
    // Same content as last time, and the stored verdict said unhealthy.
    const seen: Monitor = {
      ...contentMonitor,
      contentHash: hashContent(brokenText),
      contentAnalyzedAt: now,
      contentHealthy: false,
      contentReason: "Application error page.",
    };

    await checkMonitor(seen, now);

    // The throttle must not resurrect the monitor — that would close the
    // incident a minute after it opened.
    expect(analyzeContent).not.toHaveBeenCalled();
    expect(writeCheckResult).toHaveBeenCalledWith(
      expect.objectContaining({ isUp: false }),
    );
  });

  it("stays up when the model judges the page healthy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      htmlResponse("<html><body><h1>Welcome to the shop</h1></body></html>"),
    );
    vi.mocked(analyzeContent).mockResolvedValue({
      healthy: true,
      reason: "Normal storefront page.",
    });

    await checkMonitor(contentMonitor, now);

    expect(writeCheckResult).toHaveBeenCalledWith(
      expect.objectContaining({ isUp: true, contentHealthy: true }),
    );
  });

  it("falls back to the HTTP verdict when the model is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse(brokenPage));
    vi.mocked(analyzeContent).mockResolvedValue(null);

    await checkMonitor(contentMonitor, now);

    expect(writeCheckResult).toHaveBeenCalledWith(
      expect.objectContaining({ isUp: true, contentHealthy: undefined }),
    );
  });

  it("does not read the body for a monitor without content checking", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(htmlResponse(brokenPage));

    await checkMonitor({ ...contentMonitor, contentCheck: false }, now);

    expect(spy).toHaveBeenCalledOnce();
    expect(analyzeContent).not.toHaveBeenCalled();
  });

  it("skips non-textual responses instead of feeding bytes to the model", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("%PDF-1.7 binary...", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );

    await checkMonitor(contentMonitor, now);

    expect(analyzeContent).not.toHaveBeenCalled();
  });
});
