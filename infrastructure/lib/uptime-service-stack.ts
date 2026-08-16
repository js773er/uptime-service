import * as path from "node:path";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  Table,
} from "aws-cdk-lib/aws-dynamodb";
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

const LAMBDA_DIR = path.join(__dirname, "..", "lambda");
/** Root tsconfig so esbuild resolves the "@/*" path alias when bundling. */
const TSCONFIG = path.join(__dirname, "..", "..", "tsconfig.json");

export class UptimeServiceStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Single table for all entities. On-demand billing: traffic is tiny and
    // bursty (one checker run per minute), so provisioned capacity would be
    // guesswork. DESTROY keeps teardown clean for a demo project — production
    // would use RETAIN + point-in-time recovery.
    const table = new Table(this, "UptimeTable", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      // Check results are stamped with expiresAt (epoch seconds) so minutely
      // history self-deletes after 30 days instead of growing forever.
      timeToLiveAttribute: "expiresAt",
    });

    // Sparse index over active monitors: only items carrying GSI1PK appear,
    // so the checker lists active monitors with one query instead of a scan.
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: AttributeType.STRING },
    });

    // Id-only monitor lookup for the public status page (no user context in
    // the public URL).
    table.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2PK", type: AttributeType.STRING },
    });

    // Alerts that keep failing end up here for inspection instead of being
    // retried forever or dropped.
    const alertDlq = new Queue(this, "AlertDlq", {
      retentionPeriod: Duration.days(14),
    });

    const alertQueue = new Queue(this, "AlertQueue", {
      // >= 6x the consumer timeout, per SQS guidance, so a retried message
      // is never redelivered while a slow consumer still holds it.
      visibilityTimeout: Duration.seconds(90),
      deadLetterQueue: { queue: alertDlq, maxReceiveCount: 3 },
    });

    // Shared shape for both lambdas: Node 22 on ARM64, 256MB, esbuild
    // bundling with the root tsconfig (resolves the "@/*" alias), and an
    // explicit log group with 7-day retention.
    const serviceLambda = (
      id: string,
      props: {
        entry: string;
        timeout: Duration;
        environment: Record<string, string>;
      },
    ) =>
      new NodejsFunction(this, id, {
        entry: path.join(LAMBDA_DIR, props.entry),
        handler: "handler",
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 256,
        timeout: props.timeout,
        environment: props.environment,
        bundling: { minify: true, tsconfig: TSCONFIG },
        logGroup: new LogGroup(this, `${id}Logs`, {
          retention: RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });

    const checker = serviceLambda("CheckerFunction", {
      entry: "checker.ts",
      // Probes run concurrently with a 10s cap each; 30s covers the batch
      // plus DynamoDB round-trips.
      timeout: Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
        ALERT_QUEUE_URL: alertQueue.queueUrl,
        // Empty when unset: the AI content check is optional and the checker
        // falls back to the plain HTTP verdict without it.
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "",
      },
    });

    const alert = serviceLambda("AlertFunction", {
      entry: "alert.ts",
      timeout: Duration.seconds(15),
      environment: {
        // Injected at deploy time (bin/app.ts loads the repo-root .env.local
        // first). A production setup would read these from Secrets Manager;
        // env passthrough keeps the demo self-contained.
        RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
        ALERT_FROM_EMAIL: process.env.ALERT_FROM_EMAIL ?? "",
        ALERT_FALLBACK_EMAIL: process.env.ALERT_FALLBACK_EMAIL ?? "",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "",
      },
    });

    // Only failed messages in a batch are retried (matches the handler's
    // batchItemFailures response).
    alert.addEventSource(
      new SqsEventSource(alertQueue, {
        batchSize: 10,
        // Wait briefly so incidents from one checker run arrive together and
        // can be correlated into a single email. The delay is bounded by the
        // 1-minute check interval, so alerting stays sub-minute.
        maxBatchingWindow: Duration.seconds(20),
        reportBatchItemFailures: true,
      }),
    );

    new Rule(this, "CheckerSchedule", {
      schedule: Schedule.rate(Duration.minutes(1)),
      targets: [new LambdaFunction(checker)],
    });

    // Least privilege: the checker reads/writes the table and sends to the
    // queue; the alert consumer only receives from the queue (granted by the
    // event source) and talks to Resend over HTTPS.
    table.grantReadWriteData(checker);
    alertQueue.grantSendMessages(checker);

    // Nothing else watches this service, so it has to watch itself. Without
    // these, the checker could stop running and the first sign would be a
    // customer asking why they never got paged.
    const ops = new Topic(this, "OpsAlarms", {
      displayName: "Uptime service alarms",
    });
    if (process.env.OPS_ALARM_EMAIL) {
      ops.addSubscription(new EmailSubscription(process.env.OPS_ALARM_EMAIL));
    }

    const alarm = (
      id: string,
      metric: Metric,
      opts: {
        threshold: number;
        evaluationPeriods: number;
        description: string;
        comparison?: ComparisonOperator;
        missingData?: TreatMissingData;
      },
    ) => {
      const a = new Alarm(this, id, {
        metric,
        threshold: opts.threshold,
        evaluationPeriods: opts.evaluationPeriods,
        alarmDescription: opts.description,
        comparisonOperator:
          opts.comparison ??
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: opts.missingData ?? TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(new SnsAction(ops));
      return a;
    };

    alarm("CheckerErrors", checker.metricErrors({ period: Duration.minutes(5) }), {
      threshold: 3,
      evaluationPeriods: 1,
      description: "Checker is throwing. Monitors may not be getting checked.",
    });

    // The schedule fires every minute, so a 5-minute window should show ~5
    // invocations. Near zero means EventBridge stopped delivering or the
    // function is unreachable — the failure mode that produces silence
    // rather than errors.
    alarm(
      "CheckerNotRunning",
      checker.metricInvocations({ period: Duration.minutes(5) }),
      {
        threshold: 2,
        evaluationPeriods: 1,
        description: "Checker has nearly stopped running.",
        comparison: ComparisonOperator.LESS_THAN_THRESHOLD,
        // Absent data here means no invocations at all, which is the thing
        // we're trying to catch.
        missingData: TreatMissingData.BREACHING,
      },
    );

    // Timeout is 30s; sustained runs past 24s mean we're about to start
    // losing whole batches.
    alarm(
      "CheckerSlow",
      checker.metricDuration({ period: Duration.minutes(5), statistic: "p95" }),
      {
        threshold: 24_000,
        evaluationPeriods: 2,
        description: "Checker p95 duration is approaching its timeout.",
      },
    );

    alarm("AlertErrors", alert.metricErrors({ period: Duration.minutes(5) }), {
      threshold: 3,
      evaluationPeriods: 1,
      description: "Alert consumer is failing. Downtime emails may not be sent.",
    });

    // Anything here already exhausted its retries, so one message is worth
    // looking at.
    alarm(
      "AlertsDeadLettered",
      alertDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      {
        threshold: 1,
        evaluationPeriods: 1,
        description: "Alerts landed in the DLQ and were never delivered.",
      },
    );

    // Alerts are supposed to go out within a minute of detection.
    alarm(
      "AlertBacklog",
      alertQueue.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(5),
      }),
      {
        threshold: 300,
        evaluationPeriods: 1,
        description: "Alerts are queued but not being delivered.",
      },
    );

    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "AlertQueueUrl", { value: alertQueue.queueUrl });
    new CfnOutput(this, "OpsAlarmTopicArn", { value: ops.topicArn });
  }
}
