import { afterEach, describe, expect, it } from "vitest";
import {
  createMonitor,
  deleteMonitor,
  getActiveMonitors,
  getMonitorById,
  getMonitorByPublicId,
  getMonitorsByUser,
  MAX_MONITORS_PER_USER,
  MonitorLimitError,
  setMonitorActive,
} from "@/lib/monitors";

/**
 * Runs against DynamoDB Local. These cover the things unit tests with mocked
 * clients can't: whether the conditional writes and transactions actually
 * behave the way the code assumes.
 */

let userCounter = 0;
const createdUsers: string[] = [];

/** Fresh partition per test so a failure doesn't cascade into the next one. */
function nextUser(): string {
  const userId = `user-${Date.now()}-${userCounter++}`;
  createdUsers.push(userId);
  return userId;
}

async function wipe(userId: string): Promise<void> {
  const monitors = await getMonitorsByUser(userId);
  await Promise.all(
    monitors.map((m) => deleteMonitor(userId, m.monitorId)),
  );
}

afterEach(async () => {
  await Promise.all(createdUsers.splice(0).map(wipe));
});

describe("monitor limit", () => {
  it("allows exactly the cap", async () => {
    const userId = nextUser();

    for (let i = 0; i < MAX_MONITORS_PER_USER; i++) {
      await createMonitor({
        userId,
        name: `Site ${i}`,
        url: `https://example.com/${i}`,
      });
    }

    const monitors = await getMonitorsByUser(userId);
    expect(monitors).toHaveLength(MAX_MONITORS_PER_USER);
  });

  it("rejects the one past the cap", async () => {
    const userId = nextUser();
    for (let i = 0; i < MAX_MONITORS_PER_USER; i++) {
      await createMonitor({ userId, name: `S${i}`, url: `https://a.com/${i}` });
    }

    await expect(
      createMonitor({ userId, name: "one too many", url: "https://b.com" }),
    ).rejects.toBeInstanceOf(MonitorLimitError);
  });

  it("holds the cap when creates race", async () => {
    const userId = nextUser();
    for (let i = 0; i < MAX_MONITORS_PER_USER - 1; i++) {
      await createMonitor({ userId, name: `S${i}`, url: `https://a.com/${i}` });
    }

    // One slot left, four requests for it. A read-then-write check would let
    // several through here.
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        createMonitor({ userId, name: `race-${i}`, url: `https://c.com/${i}` }),
      ),
    );

    const created = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        MonitorLimitError,
      );
    }
    expect(await getMonitorsByUser(userId)).toHaveLength(
      MAX_MONITORS_PER_USER,
    );
  });

  it("frees a slot on delete", async () => {
    const userId = nextUser();
    const ids: string[] = [];
    for (let i = 0; i < MAX_MONITORS_PER_USER; i++) {
      const m = await createMonitor({
        userId,
        name: `S${i}`,
        url: `https://a.com/${i}`,
      });
      ids.push(m.monitorId);
    }

    await deleteMonitor(userId, ids[0]);

    // Would throw if the counter hadn't been decremented in the same
    // transaction as the delete.
    await expect(
      createMonitor({ userId, name: "replacement", url: "https://d.com" }),
    ).resolves.toBeDefined();
  });
});

describe("sparse active-monitor index", () => {
  it("drops paused monitors and brings them back on resume", async () => {
    const userId = nextUser();
    const monitor = await createMonitor({
      userId,
      name: "Site",
      url: "https://example.com",
    });

    const isListed = async () =>
      (await getActiveMonitors()).some(
        (m) => m.monitorId === monitor.monitorId,
      );

    expect(await isListed()).toBe(true);

    await setMonitorActive(userId, monitor.monitorId, false);
    // Pausing removes the index keys, so the item leaves GSI1 entirely
    // rather than being filtered out after the read.
    expect(await isListed()).toBe(false);

    await setMonitorActive(userId, monitor.monitorId, true);
    expect(await isListed()).toBe(true);
  });

  it("returns null when pausing a monitor that isn't there", async () => {
    const result = await setMonitorActive(nextUser(), "does-not-exist", false);
    expect(result).toBeNull();
  });
});

describe("public lookup", () => {
  it("finds a monitor by id alone", async () => {
    const userId = nextUser();
    const monitor = await createMonitor({
      userId,
      name: "Public",
      url: "https://example.com",
    });

    const found = await getMonitorByPublicId(monitor.monitorId);
    expect(found?.monitorId).toBe(monitor.monitorId);
    expect(found?.name).toBe("Public");
  });

  it("returns null for an unknown id", async () => {
    expect(await getMonitorByPublicId("nope")).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("keeps one user's monitor out of another user's reads", async () => {
    const owner = nextUser();
    const stranger = nextUser();
    const monitor = await createMonitor({
      userId: owner,
      name: "Private",
      url: "https://example.com",
    });

    expect(await getMonitorById(stranger, monitor.monitorId)).toBeNull();
    expect(await getMonitorsByUser(stranger)).toHaveLength(0);

    // Deleting someone else's monitor is a no-op, not an error.
    await deleteMonitor(stranger, monitor.monitorId);
    expect(await getMonitorById(owner, monitor.monitorId)).not.toBeNull();
  });
});
