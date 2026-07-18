import { App } from "aws-cdk-lib";
import { UptimeServiceStack } from "../lib/uptime-service-stack";

const app = new App();

new UptimeServiceStack(app, "UptimeServiceStack", {
  env: { region: "ap-southeast-2" },
  description: "Uptime monitoring: checker + alerting pipeline",
});
