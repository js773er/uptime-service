/**
 * Pure incident state-machine logic, deliberately free of any AWS/IO so it can
 * be unit-tested in isolation.
 *
 *   up   -> down : open a new incident
 *   down -> up   : close the open incident
 *   otherwise    : do nothing
 *
 * "State" is simply whether an incident is currently open for the monitor.
 */

export type IncidentTransition = "open" | "close" | "none";

export function decideIncidentTransition(state: {
  hasOpenIncident: boolean;
  isUp: boolean;
}): IncidentTransition {
  if (!state.isUp && !state.hasOpenIncident) {
    return "open";
  }
  if (state.isUp && state.hasOpenIncident) {
    return "close";
  }
  return "none";
}
