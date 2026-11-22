import { Logger } from "@aws-lambda-powertools/logger";
import { afterAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { z } from "zod";

import { connect } from "@lean-ts/db";
import { testDatabaseUrl, truncateAll } from "@lean-ts/db/testing";
import { CORRELATION_HEADER } from "@lean-ts/platform";
import { httpApiEvent, lambdaContext } from "@lean-ts/platform/testing";

import { createRoutes, noteResponse } from "../src/routes.ts";

// The real Powertools router, routes, validation and database; only the API Gateway event is faked.
const handle = connect(testDatabaseUrl(), { max: 2 });
const now = new Date("2026-11-21T00:00:00.000Z");
let ids = 0;
const app = createRoutes({
  db: handle.db,
  logger: new Logger({ serviceName: "api-test", logLevel: "SILENT" }),
  now: () => now,
  newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
});
const context = lambdaContext("api");

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await truncateAll(handle.db);
});

async function send(method: string, path: string, init: { query?: string; body?: unknown } = {}) {
  const result = await app.resolve(httpApiEvent(method, path, init), context);
  return {
    status: result.statusCode,
    headers: result.headers ?? {},
    json: JSON.parse(result.body ?? "null") as unknown,
  };
}

describe("notes API", () => {
  test("creates a note and reads it back", async () => {
    const created = await send("POST", "/notes", { body: { title: "Ward round", body: "Bed 4" } });
    expect(created.status).toBe(201);
    expect(created.headers[CORRELATION_HEADER]).toEqual(expect.any(String));
    const note = noteResponse.parse(created.json);
    expect(note).toMatchObject({ title: "Ward round", status: "active", createdAt: now.toISOString() });

    const fetched = await send("GET", `/notes/${note.id}`);
    expect(fetched).toMatchObject({ status: 200, json: note });

    const listed = await send("GET", "/notes", { query: "limit=5" });
    expect(listed.json).toEqual([note]);
  });

  test("rejects an invalid body with 422 and stores nothing", async () => {
    const result = await send("POST", "/notes", { body: { title: "", unexpected: true } });
    expect(result.status).toBe(422);
    expect(result.json).toMatchObject({ error: "RequestValidationError" });
    expect((await send("GET", "/notes")).json).toEqual([]);
  });

  test("rejects an invalid query or path with 422", async () => {
    expect((await send("GET", "/notes", { query: "limit=1000" })).status).toBe(422);
    expect((await send("GET", "/notes/not-a-uuid")).status).toBe(422);
  });

  test("returns 404 for a well-formed id that does not exist", async () => {
    const missing = await send("GET", "/notes/00000000-0000-4000-8000-999999999999");
    expect(missing.status).toBe(404);
    expect(z.object({ message: z.string() }).parse(missing.json).message).toBe("Note not found");
  });
});
