import type { APIGatewayProxyEventV2, SQSEvent, SQSRecord } from "aws-lambda";
import { describe, expect, test } from "vite-plus/test";

import { createLogger, httpLambda, json, sqsLambda } from "../src/index.ts";

const lines: string[] = [];
const log = createLogger({ sink: (line) => lines.push(line) });

function httpEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "POST /notes",
    rawPath: "/notes",
    rawQueryString: "",
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      accountId: "1",
      apiId: "api",
      domainName: "example.test",
      domainPrefix: "example",
      http: { method: "POST", path: "/notes", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: "req-1",
      routeKey: "POST /notes",
      stage: "$default",
      time: "",
      timeEpoch: 0,
    },
    ...overrides,
  };
}

describe("httpLambda", () => {
  test("passes the parsed body and echoes the caller's correlation ID", async () => {
    const handler = httpLambda(async (request) => json(200, { got: request.body }), log);
    const result = await handler(httpEvent({ body: '{"a":1}', headers: { "x-correlation-id": "corr-9" } }));
    expect(result).toMatchObject({ statusCode: 200, body: '{"got":{"a":1}}' });
    expect(result.headers).toMatchObject({ "x-correlation-id": "corr-9" });
  });

  test("rejects invalid JSON before the handler runs", async () => {
    let called = false;
    const handler = httpLambda(async () => {
      called = true;
      return json(200, {});
    }, log);
    const result = await handler(httpEvent({ body: "{not json" }));
    expect(result.statusCode).toBe(400);
    expect(called).toBe(false);
  });

  test("turns an unexpected error into a 500 without leaking its message", async () => {
    const handler = httpLambda(async () => {
      throw new Error("db password is hunter2");
    }, log);
    const result = await handler(httpEvent());
    expect(result).toMatchObject({ statusCode: 500, body: '{"title":"Internal error"}' });
  });
});

function sqsRecord(messageId: string, body: string): SQSRecord {
  return {
    messageId,
    receiptHandle: "r",
    body,
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "0",
      SenderId: "s",
      ApproximateFirstReceiveTimestamp: "0",
    },
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:eu-west-2:1:q",
    awsRegion: "eu-west-2",
  };
}

describe("sqsLambda", () => {
  test("reports only the records that failed, including unparsable ones", async () => {
    const handled: string[] = [];
    const handler = sqsLambda(async (message) => {
      if (message.messageId === "m-2") throw new Error("boom");
      handled.push(message.messageId);
    }, log);
    const event: SQSEvent = { Records: [sqsRecord("m-1", "{}"), sqsRecord("m-2", "{}"), sqsRecord("m-3", "{bad")] };

    const result = await handler(event);

    expect(handled).toEqual(["m-1"]);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m-2" }, { itemIdentifier: "m-3" }]);
  });
});
