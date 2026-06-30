import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Monitor } from "@/types";

vi.mock("@/lib/monitors", () => ({
  getMonitorsByUser: vi.fn(),
  createMonitor: vi.fn(),
}));

import { createMonitor, getMonitorsByUser } from "@/lib/monitors";
import { GET, POST } from "./route";

const sampleMonitor = (over: Partial<Monitor> = {}): Monitor => ({
  userId: "dev-user",
  monitorId: "m1",
  name: "Site",
  url: "https://example.com",
  active: true,
  createdAt: "2026-06-30T00:00:00.000Z",
  ...over,
});

function postRequest(body: unknown): Request {
  return new Request("http://test/api/monitors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/monitors", () => {
  it("returns the user's monitors", async () => {
    vi.mocked(getMonitorsByUser).mockResolvedValue([sampleMonitor()]);

    const res = await GET(new Request("http://test/api/monitors"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ monitors: [sampleMonitor()] });
  });
});

describe("POST /api/monitors", () => {
  it("creates a monitor and returns 201", async () => {
    vi.mocked(getMonitorsByUser).mockResolvedValue([]);
    vi.mocked(createMonitor).mockResolvedValue(sampleMonitor());

    const res = await POST(postRequest({ name: "Site", url: "https://example.com" }));
    expect(res.status).toBe(201);
    expect(createMonitor).toHaveBeenCalledOnce();
  });

  it("rejects invalid input with 400", async () => {
    vi.mocked(getMonitorsByUser).mockResolvedValue([]);

    const res = await POST(postRequest({ name: "Site", url: "http://10.0.0.1" }));
    expect(res.status).toBe(400);
    expect(createMonitor).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is at the 5-monitor limit", async () => {
    vi.mocked(getMonitorsByUser).mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => sampleMonitor({ monitorId: `m${i}` })),
    );

    const res = await POST(postRequest({ name: "Site", url: "https://example.com" }));
    expect(res.status).toBe(403);
    expect(createMonitor).not.toHaveBeenCalled();
  });
});
