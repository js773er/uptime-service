import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

/**
 * Table setup for integration tests, kept in sync with the CDK stack by hand.
 * If you add an index there, add it here or the tests will pass against a
 * schema production doesn't have.
 */

export const LOCAL_ENDPOINT = "http://localhost:8000";
export const LOCAL_TABLE = "uptime-integration";

export function localClient(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: LOCAL_ENDPOINT,
    region: "ap-southeast-2",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
}

export async function createTable(client: DynamoDBClient): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: LOCAL_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
        { AttributeName: "GSI1PK", AttributeType: "S" },
        { AttributeName: "GSI1SK", AttributeType: "S" },
        { AttributeName: "GSI2PK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
        {
          IndexName: "GSI2",
          KeySchema: [{ AttributeName: "GSI2PK", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
}

export async function dropTable(client: DynamoDBClient): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: LOCAL_TABLE }));
}
