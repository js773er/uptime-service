import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseEnv } from "node:util";
import { App } from "aws-cdk-lib";
import { UptimeServiceStack } from "../lib/uptime-service-stack";

/**
 * Deploy-time secrets (Resend key, alert emails) live in the repo-root
 * .env.local alongside the web app's. Shell exports still take precedence —
 * file values only fill in what's missing.
 */
for (const file of [".env.local", ".env"]) {
  let contents: string;
  try {
    contents = readFileSync(path.join(__dirname, "..", "..", file), "utf8");
  } catch {
    continue;
  }
  for (const [key, value] of Object.entries(parseEnv(contents))) {
    process.env[key] ??= value;
  }
}

const app = new App();

new UptimeServiceStack(app, "UptimeServiceStack", {
  env: { region: "ap-southeast-2" },
  description: "Uptime monitoring: checker + alerting pipeline",
});
