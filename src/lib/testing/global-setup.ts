import DynamoDbLocal from "dynamodb-local";
import { createTable, dropTable, localClient } from "./local-table";

const PORT = 8000;

/**
 * Runs DynamoDB Local for the integration suite. Needs Java on PATH; the jar
 * is downloaded once on first run.
 */
export async function setup(): Promise<void> {
  await DynamoDbLocal.launch(PORT, null, ["-sharedDb", "-inMemory"]);

  const client = localClient();

  // Launch resolves before the process is actually accepting connections.
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await createTable(client);
      client.destroy();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  client.destroy();
  await DynamoDbLocal.stop(PORT);
  throw new Error(`DynamoDB Local never came up: ${String(lastError)}`);
}

export async function teardown(): Promise<void> {
  const client = localClient();
  await dropTable(client).catch(() => {});
  client.destroy();
  await DynamoDbLocal.stop(PORT);
}
