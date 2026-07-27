import { describe, expect, it } from "vitest";
import { decideIncidentTransition } from "./incident-logic";

describe("decideIncidentTransition", () => {
  it("opens an incident when a healthy monitor goes down", () => {
    expect(
      decideIncidentTransition({ hasOpenIncident: false, isUp: false }),
    ).toBe("open");
  });

  it("closes the incident when a down monitor recovers", () => {
    expect(
      decideIncidentTransition({ hasOpenIncident: true, isUp: true }),
    ).toBe("close");
  });

  it("does nothing while a monitor stays up", () => {
    expect(
      decideIncidentTransition({ hasOpenIncident: false, isUp: true }),
    ).toBe("none");
  });

  it("does nothing while a monitor stays down (incident already open)", () => {
    expect(
      decideIncidentTransition({ hasOpenIncident: true, isUp: false }),
    ).toBe("none");
  });
});
