import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  closeIncident,
  getIncidentsByMonitor,
  getOpenIncident,
} from "@/lib/incidents";
import { openIncident } from "@/lib/incidents";

/**
 * The open-incident slot is the piece the whole alerting story rests on: if
 * two checker runs can both open one, users get duplicate emails and an
 * incident that never closes. Mocks can't tell you whether the conditional
 * write actually holds, so these run against DynamoDB Local.
 */

const monitorId = () => `m-${randomUUID()}`;
const at = (minutes: number) =>
  new Date(Date.UTC(2026, 7, 13, 0, minutes)).toISOString();

describe("opening an incident", () => {
  it("stores it in the open slot", async () => {
    const id = monitorId();

    const incident = await openIncident({
      monitorId: id,
      startedAt: at(0),
      statusCode: 503,
    });

    expect(incident).not.toBeNull();
    const open = await getOpenIncident(id);
    expect(open?.incidentId).toBe(incident?.incidentId);
    expect(open?.statusCode).toBe(503);
  });

  it("lets only one of several concurrent runs win", async () => {
    const id = monitorId();

    // Overlapping invocations all see "no open incident" and try to claim it.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        openIncident({ monitorId: id, startedAt: at(0), statusCode: 500 }),
      ),
    );

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);

    const open = await getOpenIncident(id);
    expect(open?.incidentId).toBe(winners[0]?.incidentId);
  });

  it("reports no open incident for a healthy monitor", async () => {
    expect(await getOpenIncident(monitorId())).toBeNull();
  });
});

describe("closing an incident", () => {
  it("clears the slot and files it in history with a duration", async () => {
    const id = monitorId();
    const incident = await openIncident({
      monitorId: id,
      startedAt: at(0),
      statusCode: 503,
    });

    await closeIncident(incident!, at(5));

    expect(await getOpenIncident(id)).toBeNull();

    const history = await getIncidentsByMonitor(id);
    expect(history).toHaveLength(1);
    expect(history[0].resolvedAt).toBe(at(5));
    expect(history[0].durationMs).toBe(5 * 60 * 1000);
  });

  it("is a no-op the second time", async () => {
    const id = monitorId();
    const incident = await openIncident({
      monitorId: id,
      startedAt: at(0),
      statusCode: 503,
    });

    await closeIncident(incident!, at(5));
    // A retried invocation must not write a duplicate history entry.
    await closeIncident(incident!, at(9));

    expect(await getIncidentsByMonitor(id)).toHaveLength(1);
  });

  it("frees the slot so the next outage can open one", async () => {
    const id = monitorId();
    const first = await openIncident({
      monitorId: id,
      startedAt: at(0),
      statusCode: 503,
    });
    await closeIncident(first!, at(5));

    const second = await openIncident({
      monitorId: id,
      startedAt: at(10),
      statusCode: 502,
    });

    expect(second).not.toBeNull();
    expect(second?.incidentId).not.toBe(first?.incidentId);
    expect((await getOpenIncident(id))?.incidentId).toBe(second?.incidentId);
  });
});

describe("incident history", () => {
  it("comes back newest first with the open one at the top", async () => {
    const id = monitorId();

    for (const start of [0, 10, 20]) {
      const incident = await openIncident({
        monitorId: id,
        startedAt: at(start),
        statusCode: 503,
      });
      await closeIncident(incident!, at(start + 5));
    }
    const ongoing = await openIncident({
      monitorId: id,
      startedAt: at(30),
      statusCode: 500,
    });

    const history = await getIncidentsByMonitor(id);

    expect(history).toHaveLength(4);
    // "INCIDENT#OPEN" sorts after every dated key, so a descending query puts
    // the ongoing incident first without a filter or an in-memory sort.
    expect(history[0].incidentId).toBe(ongoing?.incidentId);
    expect(history[0].resolvedAt).toBeUndefined();
    expect(history.slice(1).map((i) => i.startedAt)).toEqual([
      at(20),
      at(10),
      at(0),
    ]);
  });

  it("honours the limit", async () => {
    const id = monitorId();
    for (const start of [0, 10, 20]) {
      const incident = await openIncident({
        monitorId: id,
        startedAt: at(start),
        statusCode: 503,
      });
      await closeIncident(incident!, at(start + 5));
    }

    expect(await getIncidentsByMonitor(id, 2)).toHaveLength(2);
  });
});
