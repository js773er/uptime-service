import { describe, expect, it } from "vitest";
import {
  createMonitorSchema,
  getUrlRejectionReason,
} from "@/lib/schemas";

describe("getUrlRejectionReason", () => {
  it("accepts public https URLs", () => {
    expect(getUrlRejectionReason("https://example.com")).toBeNull();
    expect(getUrlRejectionReason("https://api.example.com/health")).toBeNull();
    expect(getUrlRejectionReason("https://8.8.8.8")).toBeNull();
  });

  it("rejects non-https schemes", () => {
    expect(getUrlRejectionReason("http://example.com")).toMatch(/https/);
    expect(getUrlRejectionReason("ftp://example.com")).toMatch(/https/);
  });

  it("rejects garbage / non-URLs", () => {
    expect(getUrlRejectionReason("not a url")).not.toBeNull();
    expect(getUrlRejectionReason("")).not.toBeNull();
  });

  it("rejects localhost in all its forms", () => {
    expect(getUrlRejectionReason("https://localhost")).not.toBeNull();
    expect(getUrlRejectionReason("https://localhost:3000")).not.toBeNull();
    expect(getUrlRejectionReason("https://foo.localhost")).not.toBeNull();
    expect(getUrlRejectionReason("https://127.0.0.1")).not.toBeNull();
    expect(getUrlRejectionReason("https://[::1]")).not.toBeNull();
  });

  it("rejects private IPv4 ranges", () => {
    expect(getUrlRejectionReason("https://10.0.0.1")).not.toBeNull();
    expect(getUrlRejectionReason("https://10.255.255.255")).not.toBeNull();
    expect(getUrlRejectionReason("https://192.168.1.1")).not.toBeNull();
    expect(getUrlRejectionReason("https://172.16.0.1")).not.toBeNull();
    expect(getUrlRejectionReason("https://172.31.255.255")).not.toBeNull();
  });

  it("allows public IPs that look close to private ranges", () => {
    // 172.15.x and 172.32.x are outside the 172.16–31 private block.
    expect(getUrlRejectionReason("https://172.15.0.1")).toBeNull();
    expect(getUrlRejectionReason("https://172.32.0.1")).toBeNull();
    expect(getUrlRejectionReason("https://11.0.0.1")).toBeNull();
  });

  it("rejects the cloud metadata link-local address", () => {
    expect(getUrlRejectionReason("https://169.254.169.254")).not.toBeNull();
  });
});

describe("createMonitorSchema", () => {
  it("accepts a valid payload", () => {
    const result = createMonitorSchema.safeParse({
      name: "My site",
      url: "https://example.com",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing name", () => {
    const result = createMonitorSchema.safeParse({
      name: "",
      url: "https://example.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a bad URL", () => {
    const result = createMonitorSchema.safeParse({
      name: "Internal service",
      url: "http://192.168.0.1",
    });
    expect(result.success).toBe(false);
  });
});
