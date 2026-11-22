import { fileURLToPath } from "node:url";

import { App } from "aws-cdk-lib";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

import { defaultAssets, LeanTsStack } from "../src/lean-ts-stack.ts";

// Settings come from CDK context: cdk.json defaults, overridden per run with
// `cdk deploy -c stage=prod -c databaseSecretArn=arn:…`.
const app = new App();
const context = (key: string): string | undefined => {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === "string" && value !== "" ? value : undefined;
};

const stage = context("stage") ?? "dev";
const databaseSecretArn = context("databaseSecretArn");
if (databaseSecretArn === undefined) throw new Error("Set context databaseSecretArn (the postgres:// URL secret)");
const region = process.env["CDK_DEFAULT_REGION"] ?? "eu-west-2";
const vpcId = context("vpcId");
const alarmEmail = context("alarmEmail");

const account = process.env["CDK_DEFAULT_ACCOUNT"];
new LeanTsStack(app, `lean-ts-${stage}`, {
  env: { region, ...(account === undefined ? {} : { account }) },
  stage,
  databaseSecretArn,
  ...(vpcId === undefined ? {} : { vpcId }),
  ...(alarmEmail === undefined ? {} : { alarmEmail }),
  logRetention: RetentionDays.ONE_MONTH,
  adotLayerArn: context("adotLayerArn") ?? `arn:aws:lambda:${region}:615299751070:layer:AWSOpenTelemetryDistroJs:14`,
  assets: defaultAssets(fileURLToPath(new URL("../..", import.meta.url))),
  tags: { app: "lean-ts", stage },
});
