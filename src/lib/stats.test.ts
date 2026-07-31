import { describe, expect, it } from "vitest";
import {
  computeUptimePercent,
  formatDuration,
  formatRelativeTime,
} from "@/lib/stats";

const now = new Date("2026-07-18T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const check = (minutesAgo: number, isUp: boolean) => ({
  isUp,
  timestamp: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
});

describe("computeUptimePercent", () => {
  it("returns 100 when every check in the window is up", () => {
    const checks = [check(5, true), check(10, true), check(15, true)];
    expect(computeUptimePercent(checks, DAY_MS, now)).toBe(100);
  });

  it("computes a mixed ratio", () => {
    const checks = [check(5, true), check(10, false), check(15, true), check(20, true)];
    expect(computeUptimePercent(checks, DAY_MS, now)).toBe(75);
  });

  it("ignores checks outside the window", () => {
    const checks = [check(5, true), check(60 * 25, false)]; // 25h ago excluded
    expect(computeUptimePercent(checks, DAY_MS, now)).toBe(100);
  });

  it("returns null when there are no checks in the window", () => {
    expect(computeUptimePercent([], DAY_MS, now)).toBeNull();
    expect(computeUptimePercent([check(60 * 25, true)], DAY_MS, now)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("picks the two most significant units", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(4 * 60_000 + 10_000)).toBe("4m 10s");
    expect(formatDuration(5 * 3_600_000 + 20 * 60_000)).toBe("5h 20m");
    expect(formatDuration(3 * DAY_MS + 2 * 3_600_000)).toBe("3d 2h");
  });
});

describe("formatRelativeTime", () => {
  it("formats increasing ages", () => {
    expect(formatRelativeTime(check(0, true).timestamp, now)).toBe("just now");
    expect(formatRelativeTime(check(2, true).timestamp, now)).toBe("2m ago");
    expect(formatRelativeTime(check(60 * 3, true).timestamp, now)).toBe("3h ago");
    expect(formatRelativeTime(check(60 * 24 * 5, true).timestamp, now)).toBe("5d ago");
  });
});
