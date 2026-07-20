import { randomUUID } from "node:crypto";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { db, monitorKey, TABLE_NAME } from "@/lib/dynamodb";
import type { Incident } from "@/types";

/**
 * Incident entity, one partition per monitor:
 *
 *   open incident:     PK MONITOR#<id>  SK INCIDENT#OPEN        (at most one)
 *   resolved incident: PK MONITOR#<id>  SK INCIDENT#<startedAt>#<incidentId>
 *
 * The open incident lives at a FIXED key: opening is a conditional put (two
 * concurrent checker runs can't both open one), reading it is a single
 * GetItem, and closing atomically moves it into the time-ordered history via
 * a transaction. History sorts newest-first for free ("INCIDENT#OPEN" sorts
 * after all dated keys, so a descending query yields the open incident first).
 */
const OPEN_INCIDENT_SK = "INCIDENT#OPEN";
const historySk = (startedAt: string, incidentId: string) =>
  `INCIDENT#${startedAt}#${incidentId}`;

interface IncidentItem extends Incident {
  PK: string;
  SK: string;
  entityType: "Incident";
}

function toIncident(item: IncidentItem): Incident {
  const { PK, SK, entityType, ...incident } = item;
  return incident;
}

/** The monitor's currently-open incident, or null if it's healthy. */
export async function getOpenIncident(
  monitorId: string,
): Promise<Incident | null> {
  const result = await db.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: monitorKey(monitorId), SK: OPEN_INCIDENT_SK },
    }),
  );

  return result.Item ? toIncident(result.Item as IncidentItem) : null;
}

/**
 * Open a new incident (up -> down). Returns null when another writer holds
 * the open slot already — e.g. an overlapping checker run — so callers can
 * skip duplicate alerts.
 */
export async function openIncident(input: {
  monitorId: string;
  startedAt: string;
  statusCode: number | null;
  error?: string;
}): Promise<Incident | null> {
  const incident: Incident = {
    monitorId: input.monitorId,
    incidentId: randomUUID(),
    startedAt: input.startedAt,
    statusCode: input.statusCode,
    error: input.error,
  };

  const item: IncidentItem = {
    PK: monitorKey(incident.monitorId),
    SK: OPEN_INCIDENT_SK,
    entityType: "Incident",
    ...incident,
  };

  try {
    await db.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return incident;
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      return null;
    }
    throw err;
  }
}

/**
 * Close an open incident (down -> up): atomically delete the open slot and
 * write the resolved record into the history. A no-op if a concurrent run
 * already closed it (or closed a different incident).
 */
export async function closeIncident(
  incident: Incident,
  resolvedAt: string,
): Promise<void> {
  const durationMs =
    new Date(resolvedAt).getTime() - new Date(incident.startedAt).getTime();

  const resolved: IncidentItem = {
    PK: monitorKey(incident.monitorId),
    SK: historySk(incident.startedAt, incident.incidentId),
    entityType: "Incident",
    ...incident,
    resolvedAt,
    durationMs,
  };

  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: TABLE_NAME,
              Key: {
                PK: monitorKey(incident.monitorId),
                SK: OPEN_INCIDENT_SK,
              },
              ConditionExpression: "incidentId = :id",
              ExpressionAttributeValues: { ":id": incident.incidentId },
            },
          },
          { Put: { TableName: TABLE_NAME, Item: resolved } },
        ],
      }),
    );
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      return;
    }
    throw err;
  }
}

/**
 * Incident history for a monitor. Descending SK order returns the open
 * incident (if any) first, then resolved incidents newest-first — no filter,
 * no in-memory sort, and `limit` bounds the read.
 */
export async function getIncidentsByMonitor(
  monitorId: string,
  limit = 20,
): Promise<Incident[]> {
  const result = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": monitorKey(monitorId),
        ":sk": "INCIDENT#",
      },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );

  return (result.Items ?? []).map((i) => toIncident(i as IncidentItem));
}
