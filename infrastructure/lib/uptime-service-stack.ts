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
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
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

    const checkerLogs = new LogGroup(this, "CheckerLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const checker = new NodejsFunction(this, "CheckerFunction", {
      entry: path.join(LAMBDA_DIR, "checker.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      // Probes run concurrently with a 10s cap each; 30s covers the batch
      // plus DynamoDB round-trips.
      timeout: Duration.seconds(30),
      logGroup: checkerLogs,
      environment: {
        TABLE_NAME: table.tableName,
        ALERT_QUEUE_URL: alertQueue.queueUrl,
      },
      bundling: { minify: true, tsconfig: TSCONFIG },
    });

    const alertLogs = new LogGroup(this, "AlertLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const alert = new NodejsFunction(this, "AlertFunction", {
      entry: path.join(LAMBDA_DIR, "alert.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(15),
      logGroup: alertLogs,
      environment: {
        // Injected at deploy time. A production setup would read these from
        // Secrets Manager; env passthrough keeps the demo self-contained.
        RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
        ALERT_FROM_EMAIL: process.env.ALERT_FROM_EMAIL ?? "",
        ALERT_FALLBACK_EMAIL: process.env.ALERT_FALLBACK_EMAIL ?? "",
      },
      bundling: { minify: true, tsconfig: TSCONFIG },
    });

    // Only failed messages in a batch are retried (matches the handler's
    // batchItemFailures response).
    alert.addEventSource(
      new SqsEventSource(alertQueue, {
        batchSize: 10,
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

    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "AlertQueueUrl", { value: alertQueue.queueUrl });
  }
}
