import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { db, TABLE_NAME } from "@/lib/dynamodb";
import type { Monitor } from "@/types";

/**
 * Key helpers for the Monitor entity:
 *   PK USER#<userId>   SK MONITOR#<monitorId>
 * Querying by PK returns all of a user's monitors.
 */
const userPk = (userId: string) => `USER#${userId}`;
const monitorSk = (monitorId: string) => `MONITOR#${monitorId}`;

/** Item shape as stored in DynamoDB (domain fields + table keys). */
interface MonitorItem extends Monitor {
  PK: string;
  SK: string;
  entityType: "Monitor";
}

/** Strip the persistence-only fields before handing a Monitor to callers. */
function toMonitor(item: MonitorItem): Monitor {
  return {
    userId: item.userId,
    monitorId: item.monitorId,
    name: item.name,
    url: item.url,
    active: item.active,
    createdAt: item.createdAt,
  };
}

export async function createMonitor(input: {
  userId: string;
  name: string;
  url: string;
}): Promise<Monitor> {
  const monitor: Monitor = {
    userId: input.userId,
    monitorId: randomUUID(),
    name: input.name,
    url: input.url,
    active: true,
    createdAt: new Date().toISOString(),
  };

  const item: MonitorItem = {
    PK: userPk(monitor.userId),
    SK: monitorSk(monitor.monitorId),
    entityType: "Monitor",
    ...monitor,
  };

  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      // Guard against an (astronomically unlikely) UUID collision.
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );

  return monitor;
}

export async function getMonitorsByUser(userId: string): Promise<Monitor[]> {
  const result = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": userPk(userId),
        ":sk": "MONITOR#",
      },
    }),
  );

  return (result.Items ?? []).map((i) => toMonitor(i as MonitorItem));
}

export async function getMonitorById(
  userId: string,
  monitorId: string,
): Promise<Monitor | null> {
  const result = await db.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: monitorSk(monitorId) },
    }),
  );

  return result.Item ? toMonitor(result.Item as MonitorItem) : null;
}

export async function deleteMonitor(
  userId: string,
  monitorId: string,
): Promise<void> {
  await db.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: userPk(userId), SK: monitorSk(monitorId) },
    }),
  );
}

/**
 * Pause/resume a monitor. Returns the updated Monitor, or null if no monitor
 * with that id exists for the user.
 */
export async function setMonitorActive(
  userId: string,
  monitorId: string,
  active: boolean,
): Promise<Monitor | null> {
  try {
    const result = await db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(userId), SK: monitorSk(monitorId) },
        UpdateExpression: "SET active = :active",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":active": active },
        ReturnValues: "ALL_NEW",
      }),
    );

    return result.Attributes ? toMonitor(result.Attributes as MonitorItem) : null;
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      return null;
    }
    throw err;
  }
}
