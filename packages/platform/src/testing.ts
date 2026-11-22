/**
 * Test-only entry point (`@lean-ts/platform/testing`): the AWS events and Lambda context a
 * test hands to a real handler. Only the event is faked; routing, validation and the
 * database stay real.
 */
import type { APIGatewayProxyEventV2, Context, SQSRecord } from "aws-lambda";

export function lambdaContext(functionName: string): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName,
    functionVersion: "1",
    invokedFunctionArn: `arn:aws:lambda:eu-west-2:123456789012:function:${functionName}`,
    memoryLimitInMB: "512",
    awsRequestId: "00000000-0000-4000-8000-000000000001",
    logGroupName: `/aws/lambda/${functionName}`,
    logStreamName: "test",
    getRemainingTimeInMillis: () => 30_000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

/** An API Gateway HTTP API (payload v2) request with a JSON body. */
export function httpApiEvent(
  method: string,
  path: string,
  init: { query?: string; body?: unknown; headers?: Record<string, string> } = {},
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: init.query ?? "",
    ...(init.query === undefined ? {} : { queryStringParameters: Object.fromEntries(new URLSearchParams(init.query)) }),
    headers: { "content-type": "application/json", ...init.headers },
    isBase64Encoded: false,
    ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
    requestContext: {
      accountId: "123456789012",
      apiId: "api",
      domainName: "example.test",
      domainPrefix: "example",
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: "req-1",
      routeKey: "$default",
      stage: "$default",
      time: "",
      timeEpoch: 0,
    },
  };
}

/** One SQS record; `body` is sent as written, so a test can send invalid JSON too. */
export function sqsRecord(messageId: string, body: string, correlationId?: string): SQSRecord {
  return {
    messageId,
    receiptHandle: "rh",
    body,
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "0",
      SenderId: "s",
      ApproximateFirstReceiveTimestamp: "0",
    },
    messageAttributes:
      correlationId === undefined ? {} : { correlationId: { stringValue: correlationId, dataType: "String" } },
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:eu-west-2:123456789012:queue",
    awsRegion: "eu-west-2",
  };
}
