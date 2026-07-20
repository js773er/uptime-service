import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * Region defaults to Sydney (ap-southeast-2), the project's home region.
 * AWS_REGION is set automatically inside Lambda; locally it falls back here.
 */
const REGION = process.env.AWS_REGION ?? "ap-southeast-2";

/**
 * Single-table name. CDK injects TABLE_NAME into the Lambdas; the Next.js
 * app reads it from the environment too. Falls back to a dev-friendly name.
 */
export const TABLE_NAME = process.env.TABLE_NAME ?? "uptime-service";

const client = new DynamoDBClient({ region: REGION });

/**
 * Document client wrapper: lets us work with plain JS objects instead of
 * DynamoDB's attribute-value wire format. `removeUndefinedValues` keeps
 * optional fields (e.g. Incident.resolvedAt) from blowing up on write.
 */
export const db = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

/**
 * Canonical `MONITOR#<id>` key builder. It appears as the partition key of
 * checks and incidents AND as the monitor's sort/GSI keys — one definition
 * keeps every entity in the same partition byte-for-byte.
 */
export const monitorKey = (monitorId: string) => `MONITOR#${monitorId}`;
