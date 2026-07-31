import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Monitor } from "@/types";

vi.mock("@/lib/auth", () => ({ getUserId: vi.fn() }));
vi.mock("@/lib/monitors", () => ({
  getMonitorsByUser: vi.fn(),
  createMonitor: vi.fn(),
}));
vi.mock("@clerk/nextjs/server", () => ({
  currentUser: vi.fn(async () => ({
    primaryEmailAddress: { emailAddress: "account@example.com" },
  })),
}));

import { getUserId } from "@/lib/auth";
import { createMonitor, getMonitorsByUser } from "@/lib/monitors";
import { GET, POST } from "./route";

const sampleMonitor = (over: Partial<Monitor> = {}): Monitor => ({
  userId: "user-1",
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
  vi.mocked(getUserId).mockResolvedValue("user-1");
});

describe("GET /api/monitors", () => {
  it("returns the user's monitors", async () => {
    vi.mocked(getMonitorsByUser).mockResolvedValue([sampleMonitor()]);

    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ monitors: [sampleMonitor()] });
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getUserId).mockResolvedValue(null);

    const res = await GET();
    expect(res.status).toBe(401);
    expect(getMonitorsByUser).not.toHaveBeenCalled();
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

  it("defaults the alert email to the account email", async () => {
    vi.mocked(getMonitorsByUser).mockResolvedValue([]);
    vi.mocked(createMonitor).mockResolvedValue(sampleMonitor());

    await POST(postRequest({ name: "Site", url: "https://example.com" }));
    expect(createMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ alertEmail: "account@example.com" }),
    );
  });

  it("prefers an explicitly provided alert email", async () => {
    vi.mocked(getMonitorsByUser).mockResolvedValue([]);
    vi.mocked(createMonitor).mockResolvedValue(sampleMonitor());

    await POST(
      postRequest({
        name: "Site",
        url: "https://example.com",
        alertEmail: "ops@example.com",
      }),
    );
    expect(createMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ alertEmail: "ops@example.com" }),
    );
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getUserId).mockResolvedValue(null);

    const res = await POST(postRequest({ name: "Site", url: "https://example.com" }));
    expect(res.status).toBe(401);
    expect(createMonitor).not.toHaveBeenCalled();
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
