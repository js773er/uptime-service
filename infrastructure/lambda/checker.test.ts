import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeUrl } from "./checker";

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
});
