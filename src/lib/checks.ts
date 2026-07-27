import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { db, TABLE_NAME } from "@/lib/dynamodb";
import type { CheckResult } from "@/types";

/**
 * Check results for a monitor:
 *   PK MONITOR#<monitorId>   SK CHECK#<isoTimestamp>
 * ISO timestamps sort lexicographically, so scanning the index backwards
 * gives newest-first without a secondary index.
 */
const monitorPk = (monitorId: string) => `MONITOR#${monitorId}`;

interface CheckItem extends CheckResult {
  PK: string;
  SK: string;
  entityType: "CheckResult";
}

function toCheckResult(item: CheckItem): CheckResult {
  return {
    monitorId: item.monitorId,
    timestamp: item.timestamp,
    statusCode: item.statusCode,
    responseTimeMs: item.responseTimeMs,
    isUp: item.isUp,
    error: item.error,
  };
}

/** Persist a single check result. */
export async function writeCheckResult(check: CheckResult): Promise<void> {
  const item: CheckItem = {
    PK: monitorPk(check.monitorId),
    SK: `CHECK#${check.timestamp}`,
    entityType: "CheckResult",
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
        ":pk": monitorPk(monitorId),
        ":sk": "CHECK#",
      },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );

  return (result.Items ?? []).map((i) => toCheckResult(i as CheckItem));
}
