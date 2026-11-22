import { join } from "node:path";

import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Alarm, ComparisonOperator, Metric, TreatMissingData, type IMetric } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { SubnetType, Vpc, type IVpc } from "aws-cdk-lib/aws-ec2";
import {
  Architecture,
  Code,
  Function,
  LayerVersion,
  Runtime,
  Tracing,
  type ILayerVersion,
} from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import type { RetentionDays } from "aws-cdk-lib/aws-logs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Secret, type ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Trigger } from "aws-cdk-lib/triggers";
import type { Construct } from "constructs";

/** Where each app's build output is; tests point these at stub folders. */
export interface AppAssets {
  readonly api: string;
  readonly worker: string;
  readonly pipeline: string;
  readonly migrator: string;
  readonly web: string;
}

export interface LeanTsStackProps extends StackProps {
  /** `dev`, `staging`, `prod`: names resources and decides what is kept on delete. */
  readonly stage: string;
  /** Existing Secrets Manager secret whose value is the `postgres://…` connection string. */
  readonly databaseSecretArn: string;
  /** Existing VPC that can reach the database; functions go in its private subnets. Omit for a public endpoint. */
  readonly vpcId?: string;
  /** Receives every alarm. */
  readonly alarmEmail?: string;
  /** Log retention for every function. Set by the IG retention decision. */
  readonly logRetention: RetentionDays;
  /** ADOT (OpenTelemetry) Lambda layer for Node, region-specific. */
  readonly adotLayerArn: string;
  readonly assets: AppAssets;
}

/** Build output of every app, relative to the repository root. */
export function defaultAssets(repoRoot: string): AppAssets {
  return {
    api: join(repoRoot, "apps/api/dist"),
    worker: join(repoRoot, "apps/worker/dist"),
    pipeline: join(repoRoot, "apps/pipeline/dist"),
    migrator: join(repoRoot, "apps/migrator/dist"),
    web: join(repoRoot, "apps/web/dist"),
  };
}

/**
 * One stack per stage with every app:
 * - api: HTTP API (payload v2) → one Lambda (Powertools router);
 * - worker: SQS queue + DLQ → Lambda with partial batch responses;
 * - pipeline: durable Lambda, published version behind the `live` alias;
 * - migrator: run by a CDK Trigger before the three app functions update;
 * - web: private S3 bucket + CloudFront, `/notes*` forwarded to the API (same origin, no CORS);
 * - alarms on errors, DLQ depth, queue age, API 5xx and failed workflow runs, to one SNS topic.
 *
 * All Lambdas: nodejs24.x on arm64, X-Ray active, the ADOT layer for OpenTelemetry, Powertools
 * env, an explicit log group with retention, and read access to the database secret only.
 */
export class LeanTsStack extends Stack {
  constructor(scope: Construct, id: string, props: LeanTsStackProps) {
    super(scope, id, props);
    const isProd = props.stage === "prod";
    const secret = Secret.fromSecretCompleteArn(this, "DatabaseUrl", props.databaseSecretArn);
    const vpc = props.vpcId === undefined ? undefined : Vpc.fromLookup(this, "Vpc", { vpcId: props.vpcId });
    const adot = LayerVersion.fromLayerVersionArn(this, "AdotLayer", props.adotLayerArn);

    const alarms = new Topic(this, "Alarms", { displayName: `lean-ts ${props.stage} alarms` });
    if (props.alarmEmail !== undefined) alarms.addSubscription(new EmailSubscription(props.alarmEmail));
    const alarmOn = (alarmId: string, metric: IMetric, threshold: number, description: string) => {
      new Alarm(this, alarmId, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      }).addAlarmAction(new SnsAction(alarms));
    };

    const fn = (name: string, code: string, options: AppFunctionOptions = {}) => {
      const created = appFunction(this, name, {
        code,
        secret,
        adot,
        vpc,
        logRetention: props.logRetention,
        removal: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        ...options,
      });
      alarmOn(`${name}Errors`, created.metricErrors({ period: Duration.minutes(5) }), 1, `${name} Lambda errors`);
      return created;
    };

    // API
    const api = fn("Api", props.assets.api);
    const httpApi = new HttpApi(this, "HttpApi", { apiName: `lean-ts-${props.stage}` });
    const integration = new HttpLambdaIntegration("ApiIntegration", api);
    httpApi.addRoutes({ path: "/notes", methods: [HttpMethod.GET, HttpMethod.POST], integration });
    httpApi.addRoutes({ path: "/notes/{id}", methods: [HttpMethod.GET], integration });
    alarmOn("Api5xx", httpApi.metricServerError({ period: Duration.minutes(5) }), 1, "HTTP API 5xx responses");

    // Worker
    const deadLetters = new Queue(this, "ArchiveDlq", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    const worker = fn("Worker", props.assets.worker, { timeout: Duration.seconds(30) });
    const queue = new Queue(this, "ArchiveQueue", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // AWS guidance: at least 6x the function timeout, so retries don't overlap.
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: deadLetters, maxReceiveCount: 5 },
    });
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true }));
    alarmOn(
      "ArchiveDlqDepth",
      deadLetters.metricApproximateNumberOfMessagesVisible(),
      1,
      "Messages in the archive DLQ",
    );
    alarmOn(
      "ArchiveQueueAge",
      queue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5) }),
      300,
      "Oldest archive message waited 5 minutes",
    );

    // Durable pipeline
    const pipeline = fn("Pipeline", props.assets.pipeline, {
      timeout: Duration.minutes(5),
      durable: { executionTimeout: Duration.days(1), retentionPeriod: Duration.days(14) },
    });
    // Production invokes a published version through the alias, never $LATEST: runs in flight
    // replay on the code they started with. durableConfig makes CDK attach
    // AWSLambdaBasicDurableExecutionRolePolicy (checkpoint and state permissions).
    const live = pipeline.addAlias("live");
    alarmOn(
      "PipelineRunsFailed",
      new Metric({
        namespace: "AWS/Lambda",
        metricName: "DurableExecutionFailed",
        dimensionsMap: { FunctionName: pipeline.functionName },
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      1,
      "archive-note workflow runs failed",
    );

    // Migrations run before the app functions change; a failed migration fails the deploy.
    const migrator = fn("Migrator", props.assets.migrator, { timeout: Duration.minutes(5), tracing: false });
    new Trigger(this, "Migrate", {
      handler: migrator,
      executeBefore: [api, worker, pipeline],
      executeOnHandlerChange: true,
      timeout: Duration.minutes(5),
    });

    // Web: private bucket, CloudFront in front; API on the same origin under /notes*.
    const site = new Bucket(this, "WebBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });
    const web = new Distribution(this, "Web", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        "/notes*": {
          origin: new HttpOrigin(Fn.select(2, Fn.split("/", httpApi.apiEndpoint))),
          viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });
    new BucketDeployment(this, "WebFiles", {
      sources: [Source.asset(props.assets.web)],
      destinationBucket: site,
      distribution: web,
    });

    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "WebUrl", { value: `https://${web.distributionDomainName}` });
    new CfnOutput(this, "ArchiveQueueUrl", { value: queue.queueUrl });
    new CfnOutput(this, "PipelineAliasArn", { value: live.functionArn });
    new CfnOutput(this, "AlarmTopicArn", { value: alarms.topicArn });
  }
}

interface AppFunctionOptions {
  readonly timeout?: Duration;
  readonly tracing?: boolean;
  readonly durable?: { executionTimeout: Duration; retentionPeriod: Duration };
}

function appFunction(
  scope: Construct,
  name: string,
  options: AppFunctionOptions & {
    code: string;
    secret: ISecret;
    adot: ILayerVersion;
    vpc: IVpc | undefined;
    logRetention: RetentionDays;
    removal: RemovalPolicy;
  },
): Function {
  const traced = options.tracing ?? true;
  const created = new Function(scope, name, {
    runtime: Runtime.NODEJS_24_X,
    architecture: Architecture.ARM_64,
    handler: "handler.handler",
    code: Code.fromAsset(options.code),
    memorySize: 512,
    timeout: options.timeout ?? Duration.seconds(15),
    tracing: traced ? Tracing.ACTIVE : Tracing.DISABLED,
    layers: traced ? [options.adot] : [],
    logGroup: new LogGroup(scope, `${name}Logs`, { retention: options.logRetention, removalPolicy: options.removal }),
    environment: {
      POWERTOOLS_SERVICE_NAME: name.toLowerCase(),
      POWERTOOLS_LOG_LEVEL: "INFO",
      DATABASE_SECRET_ARN: options.secret.secretArn,
      ...(traced ? { AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument" } : {}),
    },
    ...(options.vpc === undefined
      ? {}
      : { vpc: options.vpc, vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS } }),
    ...(options.durable === undefined ? {} : { durableConfig: options.durable }),
  });
  options.secret.grantRead(created);
  return created;
}
