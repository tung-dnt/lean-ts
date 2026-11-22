import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { afterAll, describe, expect, test } from "vite-plus/test";

import { LeanTsStack, type AppAssets } from "../src/lean-ts-stack.ts";

// Stub build output, so the stack synthesizes without building every app first.
const root = mkdtempSync(join(tmpdir(), "lean-ts-assets-"));
const stub = (name: string, file: string): string => {
  mkdirSync(join(root, name));
  writeFileSync(join(root, name, file), "export {};\n");
  return join(root, name);
};
const assets: AppAssets = {
  api: stub("api", "handler.mjs"),
  worker: stub("worker", "handler.mjs"),
  pipeline: stub("pipeline", "handler.mjs"),
  migrator: stub("migrator", "handler.mjs"),
  web: stub("web", "index.html"),
};

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const secretArn = "arn:aws:secretsmanager:eu-west-2:111111111111:secret:lean-ts/test/database-url-AbCdEf";
const template = Template.fromStack(
  new LeanTsStack(new App(), "lean-ts-test", {
    env: { account: "111111111111", region: "eu-west-2" },
    stage: "test",
    databaseSecretArn: secretArn,
    logRetention: RetentionDays.ONE_MONTH,
    adotLayerArn: "arn:aws:lambda:eu-west-2:615299751070:layer:AWSOpenTelemetryDistroJs:14",
    assets,
  }),
);

describe("LeanTsStack", () => {
  test("every app Lambda is nodejs24.x on arm64 and reads the database URL from the secret, never from env", () => {
    template.resourcePropertiesCountIs(
      "AWS::Lambda::Function",
      {
        Handler: "handler.handler",
        Runtime: "nodejs24.x",
        Architectures: ["arm64"],
        Environment: { Variables: Match.objectLike({ DATABASE_SECRET_ARN: secretArn, DATABASE_URL: Match.absent() }) },
      },
      4,
    );
  });

  test("the pipeline is a durable function behind a `live` alias", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      DurableConfig: { ExecutionTimeout: 86_400, RetentionPeriodInDays: 14 },
      TracingConfig: { Mode: "Active" },
      Environment: { Variables: Match.objectLike({ AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument" }) },
    });
    template.hasResourceProperties("AWS::Lambda::Alias", { Name: "live" });
  });

  test("the worker reports partial batch failures, and failing messages end in a DLQ after 5 tries", () => {
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      BatchSize: 10,
    });
    template.hasResourceProperties("AWS::SQS::Queue", { RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }) });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "ApproximateNumberOfMessagesVisible",
      Threshold: 1,
    });
  });

  test("migrations run before the app functions are updated", () => {
    expect(Object.keys(template.findResources("Custom::Trigger"))).toHaveLength(1);
    const appFunctions = Object.entries(template.findResources("AWS::Lambda::Function")).filter(([id]) =>
      /^(Api|Worker|Pipeline)[A-F0-9]{8}$/.test(id),
    );
    expect(appFunctions).toHaveLength(3);
    for (const [, resource] of appFunctions) {
      const dependsOn: unknown = resource["DependsOn"];
      expect(
        Array.isArray(dependsOn) && dependsOn.some((id) => typeof id === "string" && id.startsWith("Migrate")),
      ).toBe(true);
    }
  });

  test("the web bucket is private and served only through CloudFront, with the API on the same origin", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: [Match.objectLike({ PathPattern: "/notes*", ViewerProtocolPolicy: "https-only" })],
      }),
    });
  });

  test("every function has a log group with retention and an error alarm", () => {
    template.resourcePropertiesCountIs("AWS::Logs::LogGroup", { RetentionInDays: 30 }, 4);
    template.resourcePropertiesCountIs("AWS::CloudWatch::Alarm", { MetricName: "Errors", Threshold: 1 }, 4);
  });
});
