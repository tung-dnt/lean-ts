import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import { afterAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { connect } from "@lean-ts/db";
import { testDatabaseUrl, truncateAll } from "@lean-ts/db/testing";
import { createLogger, httpLambda } from "@lean-ts/platform";

import { createRouter } from "../src/routes.ts";

// The real Lambda adapter, router and database; only the API Gateway event is faked.
const handle = connect(testDatabaseUrl(), { max: 2 });
const now = new Date("2026-11-21T00:00:00.000Z");
let ids = 0;
const handler = httpLambda(
  createRouter({
    db: handle.db,
    now: () => now,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  }),
  createLogger({ sink: () => {} }),
);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await truncateAll(handle.db);
});

function event(routeKey: string, init: { path?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const [method = "GET", route = "/"] = routeKey.split(" ");
  const path = init.path ?? route;
  const request: APIGatewayProxyEventV2 = {
    version: "2.0",
    routeKey,
    rawPath: path,
    rawQueryString: "",
    headers: {},
    isBase64Encoded: false,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.params === undefined ? {} : { pathParameters: init.params }),
    requestContext: {
      accountId: "1",
      apiId: "api",
      domainName: "example.test",
      domainPrefix: "example",
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: "req-1",
      routeKey,
      stage: "$default",
      time: "",
      timeEpoch: 0,
    },
  };
  return request;
}

const parse = (body: string | undefined): unknown => (body === undefined ? undefined : JSON.parse(body));

describe("notes API", () => {
  test("creates a note and reads it back", async () => {
    const created = await handler(event("POST /notes", { body: { title: "Ward round", body: "Bed 4" } }));
    expect(created.statusCode).toBe(201);
    const note = z.object({ id: z.uuid() }).parse(parse(created.body));

    const fetched = await handler(event("GET /notes/{id}", { path: `/notes/${note.id}`, params: { id: note.id } }));
    expect(fetched.statusCode).toBe(200);
    expect(parse(fetched.body)).toMatchObject({ id: note.id, title: "Ward round", status: "active" });

    const listed = await handler(event("GET /notes"));
    expect(parse(listed.body)).toHaveLength(1);
  });

  test("rejects an invalid note with 422 and stores nothing", async () => {
    const result = await handler(event("POST /notes", { body: { title: "" } }));
    expect(result.statusCode).toBe(422);
    expect(parse((await handler(event("GET /notes"))).body)).toEqual([]);
  });

  test("returns 404 for an unknown or malformed id", async () => {
    const missing = "00000000-0000-4000-8000-999999999999";
    expect((await handler(event("GET /notes/{id}", { params: { id: missing } }))).statusCode).toBe(404);
    expect((await handler(event("GET /notes/{id}", { params: { id: "not-a-uuid" } }))).statusCode).toBe(404);
  });
});
