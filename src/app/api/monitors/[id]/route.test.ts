import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Monitor } from "@/types";

vi.mock("@/lib/monitors", () => ({
  getMonitorById: vi.fn(),
  setMonitorActive: vi.fn(),
  deleteMonitor: vi.fn(),
}));
vi.mock("@/lib/checks", () => ({
  getRecentChecks: vi.fn(),
}));

import { getRecentChecks } from "@/lib/checks";
import {
  deleteMonitor,
  getMonitorById,
  setMonitorActive,
} from "@/lib/monitors";
import { DELETE, GET, PATCH } from "./route";

const monitor: Monitor = {
  userId: "dev-user",
  monitorId: "m1",
  name: "Site",
  url: "https://example.com",
  active: true,
  createdAt: "2026-06-30T00:00:00.000Z",
};

const ctx = (id = "m1") => ({ params: Promise.resolve({ id }) });

function patchRequest(body: unknown): Request {
  return new Request("http://test/api/monitors/m1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/monitors/[id]", () => {
  it("returns the monitor and its recent checks", async () => {
    vi.mocked(getMonitorById).mockResolvedValue(monitor);
    vi.mocked(getRecentChecks).mockResolvedValue([]);

    const res = await GET(new Request("http://test/api/monitors/m1"), ctx());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ monitor, checks: [] });
  });

  it("returns 404 when the monitor is missing", async () => {
    vi.mocked(getMonitorById).mockResolvedValue(null);

    const res = await GET(new Request("http://test/api/monitors/m1"), ctx());
    expect(res.status).toBe(404);
    expect(getRecentChecks).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/monitors/[id]", () => {
  it("pauses a monitor", async () => {
    vi.mocked(setMonitorActive).mockResolvedValue({ ...monitor, active: false });

    const res = await PATCH(patchRequest({ active: false }), ctx());
    expect(res.status).toBe(200);
    expect(setMonitorActive).toHaveBeenCalledWith("dev-user", "m1", false);
  });

  it("rejects a bad body with 400", async () => {
    const res = await PATCH(patchRequest({ active: "nope" }), ctx());
    expect(res.status).toBe(400);
    expect(setMonitorActive).not.toHaveBeenCalled();
  });

  it("returns 404 when the monitor is missing", async () => {
    vi.mocked(setMonitorActive).mockResolvedValue(null);

    const res = await PATCH(patchRequest({ active: true }), ctx());
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/monitors/[id]", () => {
  it("deletes an existing monitor and returns 204", async () => {
    vi.mocked(getMonitorById).mockResolvedValue(monitor);

    const res = await DELETE(new Request("http://test/api/monitors/m1", { method: "DELETE" }), ctx());
    expect(res.status).toBe(204);
    expect(deleteMonitor).toHaveBeenCalledWith("dev-user", "m1");
  });

  it("returns 404 when the monitor is missing", async () => {
    vi.mocked(getMonitorById).mockResolvedValue(null);

    const res = await DELETE(new Request("http://test/api/monitors/m1", { method: "DELETE" }), ctx());
    expect(res.status).toBe(404);
    expect(deleteMonitor).not.toHaveBeenCalled();
  });
});
