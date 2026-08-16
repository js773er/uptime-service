import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Integration suite: runs against DynamoDB Local instead of mocks. Separate
 * from the unit config so `npm test` stays fast and needs nothing installed.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["./src/lib/testing/global-setup.ts"],
    // Conditional writes race against each other on purpose, so files can't
    // share one table.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 120_000,
    env: {
      DYNAMODB_ENDPOINT: "http://localhost:8000",
      TABLE_NAME: "uptime-integration",
      AWS_REGION: "ap-southeast-2",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
