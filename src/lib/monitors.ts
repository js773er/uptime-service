import { randomUUID } from "node:crypto";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { db, monitorKey, TABLE_NAME } from "@/lib/dynamodb";
import type { Monitor } from "@/types";

/**
 * Key helpers for the Monitor entity:
 *   PK USER#<userId>   SK MONITOR#<monitorId>
 * Querying by PK returns all of a user's monitors. A per-user counter item
 * (SK MONITOR_COUNT — outside the MONITOR# prefix, so list queries skip it)
 * enforces the monitor cap atomically.
 */
const userPk = (userId: string) => `USER#${userId}`;
const monitorSk = monitorKey;
const COUNT_SK = "MONITOR_COUNT";

/** Free-tier cap, enforced in the database, surfaced in API and UI. */
export const MAX_MONITORS_PER_USER = 5;

/** Thrown when a create would exceed the cap; the API maps it to a 403. */
export class MonitorLimitError extends Error {
  constructor() {
    super(`monitor limit reached (max ${MAX_MONITORS_PER_USER})`);
    this.name = "MonitorLimitError";
  }
}

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

/**
 * Id-only lookup index for the public status page: the public URL carries just
 * a monitorId, but the base-table key is USER#<userId>. Every monitor carries
 * GSI2PK = MONITOR#<monitorId> (one item per partition).
 */
export const MONITOR_BY_ID_INDEX = "GSI2";

/** Item shape as stored in DynamoDB (domain fields + table keys). */
interface MonitorItem extends Monitor {
  PK: string;
  SK: string;
  entityType: "Monitor";
  /** Present only while active (sparse index). */
  GSI1PK?: string;
  GSI1SK?: string;
  /** Always present: id-only lookup for the public status page. */
  GSI2PK: string;
}

/** Strip the persistence-only fields before handing a Monitor to callers. */
function toMonitor(item: MonitorItem): Monitor {
  // Rest-destructure so new domain fields flow through without editing this.
  const { PK, SK, entityType, GSI1PK, GSI1SK, GSI2PK, ...monitor } = item;
  return monitor;
}

/**
 * Create a monitor and bump the user's counter in one transaction. The
 * counter's condition makes the cap atomic — two concurrent creates at the
 * limit cannot both slip through a read-then-write window.
 */
export async function createMonitor(input: {
  userId: string;
  name: string;
  url: string;
  alertEmail?: string;
  contentCheck?: boolean;
}): Promise<Monitor> {
  const monitor: Monitor = {
    userId: input.userId,
    monitorId: randomUUID(),
    name: input.name,
    url: input.url,
    active: true,
    alertEmail: input.alertEmail,
    contentCheck: input.contentCheck,
    createdAt: new Date().toISOString(),
  };

  const item: MonitorItem = {
    PK: userPk(monitor.userId),
    SK: monitorSk(monitor.monitorId),
    entityType: "Monitor",
    // Active on creation -> include the sparse index keys.
    GSI1PK: ACTIVE_INDEX_PK,
    GSI1SK: monitorSk(monitor.monitorId),
    GSI2PK: monitorSk(monitor.monitorId),
    ...monitor,
  };

  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: userPk(monitor.userId), SK: COUNT_SK },
              UpdateExpression: "ADD monitorCount :one",
              ConditionExpression:
                "attribute_not_exists(PK) OR monitorCount < :max",
              ExpressionAttributeValues: {
                ":one": 1,
                ":max": MAX_MONITORS_PER_USER,
              },
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: item,
              // Guard against an (astronomically unlikely) UUID collision.
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (
      err instanceof TransactionCanceledException &&
      err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
    ) {
      throw new MonitorLimitError();
    }
    throw err;
  }

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

/**
 * Look a monitor up by id alone — used by the public status page, which has
 * no user context. Returns null for unknown ids.
 */
export async function getMonitorByPublicId(
  monitorId: string,
): Promise<Monitor | null> {
  const result = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: MONITOR_BY_ID_INDEX,
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": monitorSk(monitorId) },
      Limit: 1,
    }),
  );

  const item = result.Items?.[0];
  return item ? toMonitor(item as MonitorItem) : null;
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

/**
 * Delete a monitor: remove the item, decrement the user's counter, and clear
 * any open incident so the status page never shows a permanently "ongoing"
 * outage for a deleted monitor. Check history is left to expire via TTL.
 * A no-op if the monitor is already gone.
 */
export async function deleteMonitor(
  userId: string,
  monitorId: string,
): Promise<void> {
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: TABLE_NAME,
              Key: { PK: userPk(userId), SK: monitorSk(monitorId) },
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: userPk(userId), SK: COUNT_SK },
              UpdateExpression: "ADD monitorCount :minusOne",
              ConditionExpression: "monitorCount > :zero",
              ExpressionAttributeValues: { ":minusOne": -1, ":zero": 0 },
            },
          },
          {
            Delete: {
              TableName: TABLE_NAME,
              Key: { PK: monitorKey(monitorId), SK: "INCIDENT#OPEN" },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (
      err instanceof TransactionCanceledException &&
      err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
    ) {
      return;
    }
    throw err;
  }
}

/**
 * Record the outcome of a content analysis on the monitor item. Stored here
 * rather than derived from check history so the checker gets the throttling
 * state for free — the monitor is already in memory from its work-list query.
 */
export async function recordContentAnalysis(input: {
  userId: string;
  monitorId: string;
  contentHash: string;
  analyzedAt: string;
  healthy: boolean;
  reason: string;
}): Promise<void> {
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: userPk(input.userId),
        SK: monitorSk(input.monitorId),
      },
      // The verdict is stored alongside the hash it belongs to, so a later
      // check with unchanged content can reuse it instead of losing it.
      UpdateExpression:
        "SET contentHash = :hash, contentAnalyzedAt = :analyzedAt, " +
        "contentHealthy = :healthy, contentReason = :reason",
      // Skip silently if the monitor was deleted mid-check.
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: {
        ":hash": input.contentHash,
        ":analyzedAt": input.analyzedAt,
        ":healthy": input.healthy,
        ":reason": input.reason,
      },
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
  const command = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: userPk(userId), SK: monitorSk(monitorId) },
    UpdateExpression: active
      ? "SET #active = :active, GSI1PK = :gpk, GSI1SK = :gsk"
      : "SET #active = :active REMOVE GSI1PK, GSI1SK",
    ConditionExpression: "attribute_exists(PK)",
    ExpressionAttributeNames: { "#active": "active" },
    ExpressionAttributeValues: active
      ? { ":active": true, ":gpk": ACTIVE_INDEX_PK, ":gsk": monitorSk(monitorId) }
      : { ":active": false },
    ReturnValues: "ALL_NEW",
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
