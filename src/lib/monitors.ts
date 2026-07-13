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

/**
 * Sparse GSI used by the checker to list every active monitor across all users
 * without scanning the (check-result-dominated) base table.
 *
 * Only active monitors carry GSI1PK/GSI1SK; pausing a monitor removes those
 * attributes so it drops out of the index. Defined in the CDK stack (Step 5) as
 * index "GSI1" with keys GSI1PK/GSI1SK, projection ALL.
 */
export const ACTIVE_MONITORS_INDEX = "GSI1";
const ACTIVE_INDEX_PK = "MONITOR#ACTIVE";

/** Item shape as stored in DynamoDB (domain fields + table keys). */
interface MonitorItem extends Monitor {
  PK: string;
  SK: string;
  entityType: "Monitor";
  /** Present only while active (sparse index). */
  GSI1PK?: string;
  GSI1SK?: string;
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
    // Active on creation -> include the sparse index keys.
    GSI1PK: ACTIVE_INDEX_PK,
    GSI1SK: monitorSk(monitor.monitorId),
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

/**
 * Every active monitor across all users, via the sparse GSI. Paginates so the
 * checker sees the whole set even beyond DynamoDB's 1MB page limit.
 */
export async function getActiveMonitors(): Promise<Monitor[]> {
  const monitors: Monitor[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await db.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: ACTIVE_MONITORS_INDEX,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": ACTIVE_INDEX_PK },
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      monitors.push(toMonitor(item as MonitorItem));
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return monitors;
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
  // Keep the sparse index in sync: add the GSI keys when resuming, remove them
  // when pausing so paused monitors drop out of the checker's query.
  // `active` is aliased to sidestep any reserved-word issues.
  const command = active
    ? new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(userId), SK: monitorSk(monitorId) },
        UpdateExpression: "SET #active = :active, GSI1PK = :gpk, GSI1SK = :gsk",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#active": "active" },
        ExpressionAttributeValues: {
          ":active": true,
          ":gpk": ACTIVE_INDEX_PK,
          ":gsk": monitorSk(monitorId),
        },
        ReturnValues: "ALL_NEW" as const,
      })
    : new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPk(userId), SK: monitorSk(monitorId) },
        UpdateExpression: "SET #active = :active REMOVE GSI1PK, GSI1SK",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#active": "active" },
        ExpressionAttributeValues: { ":active": false },
        ReturnValues: "ALL_NEW" as const,
      });

  try {
    const result = await db.send(command);

    return result.Attributes ? toMonitor(result.Attributes as MonitorItem) : null;
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      return null;
    }
    throw err;
  }
}
