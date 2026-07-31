import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { UptimeServiceStack } from "./uptime-service-stack";

describe("UptimeServiceStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new UptimeServiceStack(app, "TestStack");
    template = Template.fromStack(stack);
  });

  it("creates an on-demand single table with the active-monitor index", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: "GSI1" }),
      ]),
    });
  });

  it("schedules the checker every minute", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(1 minute)",
    });
  });

  it("wires the alert queue to a DLQ after 3 attempts", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it("enables partial batch failures on the SQS event source", () => {
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  it("defines exactly the two lambdas with 7-day log retention", () => {
    template.resourceCountIs("AWS::Lambda::Function", 2);
    const logGroups = template.findResources("AWS::Logs::LogGroup");
    const retentions = Object.values(logGroups).map(
      (lg) => lg.Properties?.RetentionInDays,
    );
    expect(retentions).toEqual([7, 7]);
  });
});
