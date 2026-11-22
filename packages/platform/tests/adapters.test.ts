import { Logger } from "@aws-lambda-powertools/logger";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";

import { CORRELATION_HEADER, createHttpRouter, sqsBatchHandler } from "../src/index.ts";
import { httpApiEvent, lambdaContext, sqsRecord } from "../src/testing.ts";

const logger = new Logger({ serviceName: "platform-test", logLevel: "SILENT" });
const context = lambdaContext("platform-test");

describe("createHttpRouter", () => {
  const seen: unknown[] = [];
  const app = createHttpRouter(logger);
  app.post(
    "/notes",
    ({ valid }) => {
      seen.push(logger.getCorrelationId());
      return { title: valid.req.body.title };
    },
    { validation: { req: { body: z.strictObject({ title: z.string().min(1) }) } } },
  );
  app.get("/boom", () => {
    throw new Error("database password is hunter2");
  });

  test("keeps a caller's UUID correlation ID on the logger and the response", async () => {
    const id = "3f2f6a3e-8a57-4c39-9d36-1a1f4f3a1b2c";
    const event = httpApiEvent("POST", "/notes", { body: { title: "a" }, headers: { [CORRELATION_HEADER]: id } });
    const result = await app.resolve(event, context);
    expect(result.statusCode).toBe(200);
    expect(result.headers?.[CORRELATION_HEADER]).toBe(id);
    expect(seen.at(-1)).toBe(id);
  });

  test("replaces a correlation ID that is not a UUID", async () => {
    const event = httpApiEvent("POST", "/notes", {
      body: { title: "a" },
      headers: { [CORRELATION_HEADER]: "not-a-uuid; level=ERROR" },
    });
    const result = await app.resolve(event, context);
    expect(z.uuid().safeParse(result.headers?.[CORRELATION_HEADER]).success).toBe(true);
  });

  test("rejects a body that fails the route's schema with 422, before the handler runs", async () => {
    const before = seen.length;
    const result = await app.resolve(httpApiEvent("POST", "/notes", { body: { title: "", extra: 1 } }), context);
    expect(result.statusCode).toBe(422);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ error: "RequestValidationError" });
    expect(z.uuid().safeParse(result.headers?.[CORRELATION_HEADER]).success).toBe(true);
    expect(seen.length).toBe(before);
  });

  test("answers 404 for an unknown route and 500 without internals for an unhandled error", async () => {
    expect((await app.resolve(httpApiEvent("GET", "/nope"), context)).statusCode).toBe(404);
    const boom = await app.resolve(httpApiEvent("GET", "/boom"), context);
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain("hunter2");
  });
});

describe("sqsBatchHandler", () => {
  test("validates each body, reports only failing records, and runs records one at a time", async () => {
    const events: string[] = [];
    const handler = sqsBatchHandler({
      schema: z.strictObject({ n: z.int() }),
      logger,
      handle: async ({ messageId, body }) => {
        events.push(`start ${messageId} ${String(body.n)} ${String(logger.getCorrelationId())}`);
        // Yield: if records ran in parallel, the next record would start before this one ends.
        await Promise.resolve();
        if (body.n === 2) throw new Error("boom");
        events.push(`end ${messageId}`);
      },
    });
    const records = [sqsRecord("m1", '{"n":1}', "c-1"), sqsRecord("bad", '{"n":"x"}'), sqsRecord("m2", '{"n":2}')];

    const result = await handler({ Records: [...records, sqsRecord("m3", '{"n":3}')] }, context);

    expect(result.batchItemFailures.map((failure) => failure.itemIdentifier).toSorted()).toEqual(["bad", "m2"]);
    expect(events).toEqual(["start m1 1 c-1", "end m1", "start m2 2 m2", "start m3 3 m3", "end m3"]);
  });
});
