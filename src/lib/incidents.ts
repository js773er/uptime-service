import { randomUUID } from "node:crypto";
import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { db, TABLE_NAME } from "@/lib/dynamodb";
import type { Incident } from "@/types";

/**
 * Incident entity:
 *   PK MONITOR#<monitorId>   SK INCIDENT#<incidentId>
 * At most one incident per monitor is open (resolvedAt absent) at a time.
 */
const monitorPk = (monitorId: string) => `MONITOR#${monitorId}`;
const incidentSk = (incidentId: string) => `INCIDENT#${incidentId}`;

interface IncidentItem extends Incident {
  PK: string;
  SK: string;
  entityType: "Incident";
}

function toIncident(item: IncidentItem): Incident {
  return {
    monitorId: item.monitorId,
    incidentId: item.incidentId,
    startedAt: item.startedAt,
    resolvedAt: item.resolvedAt,
    durationMs: item.durationMs,
    statusCode: item.statusCode,
    error: item.error,
  };
}

/** The monitor's currently-open incident, or null if it's healthy. */
export async function getOpenIncident(
  monitorId: string,
): Promise<Incident | null> {
  const result = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      FilterExpression: "attribute_not_exists(resolvedAt)",
      ExpressionAttributeValues: {
        ":pk": monitorPk(monitorId),
        ":sk": "INCIDENT#",
      },
    }),
  );

  const open = result.Items?.[0];
  return open ? toIncident(open as IncidentItem) : null;
}

/** Open a new incident when a monitor transitions up -> down. */
export async function openIncident(input: {
  monitorId: string;
  startedAt: string;
  statusCode: number | null;
  error?: string;
}): Promise<Incident> {
  const incident: Incident = {
    monitorId: input.monitorId,
    incidentId: randomUUID(),
    startedAt: input.startedAt,
    statusCode: input.statusCode,
    error: input.error,
  };

  const item: IncidentItem = {
    PK: monitorPk(incident.monitorId),
    SK: incidentSk(incident.incidentId),
    entityType: "Incident",
    ...incident,
  };

  await db.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return incident;
}

/** Close an open incident when a monitor recovers down -> up. */
export async function closeIncident(
  incident: Incident,
  resolvedAt: string,
): Promise<void> {
  const durationMs =
    new Date(resolvedAt).getTime() - new Date(incident.startedAt).getTime();

  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: monitorPk(incident.monitorId),
        SK: incidentSk(incident.incidentId),
      },
      UpdateExpression: "SET resolvedAt = :resolvedAt, durationMs = :durationMs",
      // Only close it if it's still open (guards against double-close races).
      ConditionExpression: "attribute_not_exists(resolvedAt)",
      ExpressionAttributeValues: {
        ":resolvedAt": resolvedAt,
        ":durationMs": durationMs,
      },
    }),
  );
}
