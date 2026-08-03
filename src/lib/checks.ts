import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { db, monitorKey, TABLE_NAME } from "@/lib/dynamodb";
import type { CheckResult } from "@/types";

/**
 * Check results for a monitor:
 *   PK MONITOR#<monitorId>   SK CHECK#<isoTimestamp>
 * ISO timestamps sort lexicographically, so scanning the index backwards
 * gives newest-first without a secondary index.
 *
 * Minutely checks are only ever read over a 24h window; DynamoDB TTL deletes
 * them for free after 30 days, keeping table growth bounded and cleaning up
 * after deleted monitors.
 */
const CHECK_TTL_SECONDS = 30 * 24 * 60 * 60;

interface CheckItem extends CheckResult {
  PK: string;
  SK: string;
  entityType: "CheckResult";
  /** Epoch seconds; the table's TTL attribute. */
  expiresAt: number;
}

function toCheckResult(item: CheckItem): CheckResult {
  const { PK, SK, entityType, expiresAt, ...check } = item;
  return check;
}

/** Persist a single check result. */
export async function writeCheckResult(check: CheckResult): Promise<void> {
  const item: CheckItem = {
    PK: monitorKey(check.monitorId),
    SK: `CHECK#${check.timestamp}`,
    entityType: "CheckResult",
    expiresAt: Math.floor(Date.now() / 1000) + CHECK_TTL_SECONDS,
    ...check,
  };

  await db.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
}

/** Most recent check results for a monitor, newest first. */
export async function getRecentChecks(
  monitorId: string,
  limit = 50,
): Promise<CheckResult[]> {
  const result = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": monitorKey(monitorId),
        ":sk": "CHECK#",
      },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );

  return (result.Items ?? []).map((i) => toCheckResult(i as CheckItem));
}
