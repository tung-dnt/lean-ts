import { randomUUID } from "node:crypto";

import { createOtelPluginFactory } from "@aws/durable-execution-sdk-js-otel";
import { Logger } from "@aws-lambda-powertools/logger";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";

import { connect, findNote, insertNote } from "@lean-ts/db";
import { testDatabaseUrl, truncateAll } from "@lean-ts/db/testing";
import { createNote } from "@lean-ts/domain-note";

import { ARCHIVE_NOTE_WORKFLOW, archiveNoteWorkflow } from "../src/archive-note.ts";

// The real workflow, SDK, OTel plugin and PostgreSQL; only the durable backend is the
// SDK's local checkpoint server, which replays the handler the way Lambda does.
const handle = connect(testDatabaseUrl(), { max: 2 });
const archivedAt = new Date("2026-11-22T09:00:00.000Z");
const spans = new InMemorySpanExporter();
const handler = archiveNoteWorkflow({
  db: handle.db,
  log: new Logger({ serviceName: "pipeline-test" }),
  now: () => archivedAt,
  plugins: [
    createOtelPluginFactory({
      workflowSpanName: ARCHIVE_NOTE_WORKFLOW,
      tracerProviderFactory: (createIdGenerator) => {
        const provider = new NodeTracerProvider({
          idGenerator: createIdGenerator(),
          spanProcessors: [new SimpleSpanProcessor(spans)],
        });
        // Registered globally like the ADOT layer does, so steps see the active span.
        provider.register();
        return provider;
      },
    }),
  ],
});

beforeAll(async () => {
  // Real time: fake timers would also freeze the pg driver. Waits are 1 s.
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
});

afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
  await handle.close();
});

beforeEach(async () => {
  await truncateAll(handle.db);
  spans.reset();
});

async function seedNote(): Promise<string> {
  const id = randomUUID();
  const result = createNote({ title: "Follow-up call" }, id, new Date("2026-11-21T00:00:00.000Z"));
  if (!result.ok) throw new Error("fixture note is invalid");
  await insertNote(handle.db, result.value);
  return id;
}

const input = (noteId: string) => ({ noteId, correlationId: randomUUID(), graceSeconds: 1 });

describe("archive-note workflow", () => {
  test("archives after the grace period, and replay does not re-run completed steps", async () => {
    const noteId = await seedNote();
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });

    const execution = await runner.run({ payload: input(noteId) });

    expect(execution.getStatus()).toBe("SUCCEEDED");
    expect(execution.getResult()).toEqual({ outcome: "archived" });
    expect(await findNote(handle.db, noteId)).toMatchObject({ status: "archived", archivedAt });
    // The wait ends the first invocation; the second replays check-note from its checkpoint.
    expect(execution.getInvocations().length).toBe(2);
    expect(runner.getOperation("check-note").getStepDetails()).toMatchObject({ result: true, attempt: 1 });
    expect(runner.getOperation("archive").getStepDetails()).toMatchObject({ result: "archived", attempt: 1 });
  });

  test("ends without waiting when the note does not exist", async () => {
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });

    const execution = await runner.run({ payload: input(randomUUID()) });

    expect(execution.getResult()).toEqual({ outcome: "missing" });
    expect(execution.getInvocations().length).toBe(1);
  });

  test("a second run for an archived note reports it and changes nothing", async () => {
    const noteId = await seedNote();
    await new LocalDurableTestRunner({ handlerFunction: handler }).run({ payload: input(noteId) });

    const again = await new LocalDurableTestRunner({ handlerFunction: handler }).run({ payload: input(noteId) });

    expect(again.getResult()).toEqual({ outcome: "already-archived" });
    expect(await findNote(handle.db, noteId)).toMatchObject({ archivedAt });
  });

  test("rejects invalid input as a failed run", async () => {
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });

    const execution = await runner.run({ payload: { noteId: "not-a-uuid" } });

    expect(execution.getStatus()).toBe("FAILED");
  });

  test("exports one trace: the workflow span over its step spans, tagged with the correlation ID", async () => {
    const noteId = await seedNote();
    const payload = input(noteId);

    await new LocalDurableTestRunner({ handlerFunction: handler }).run({ payload });

    const finished = spans.getFinishedSpans();
    const workflow = finished.find((span) => span.name === ARCHIVE_NOTE_WORKFLOW);
    expect(workflow?.status.code).toBe(SpanStatusCode.OK);
    expect(new Set(finished.map((span) => span.spanContext().traceId)).size).toBe(1);

    const workflowId = workflow?.spanContext().spanId;
    const operations = finished
      .filter((span) => span.parentSpanContext?.spanId === workflowId)
      .map((span) => span.name);
    expect(operations).toEqual(expect.arrayContaining(["check-note", "grace-period", "archive"]));

    const tagged = finished.filter((span) => span.attributes["correlation.id"] === payload.correlationId);
    expect(tagged.map((span) => span.name)).toEqual(
      expect.arrayContaining(["check-note attempt 1", "archive attempt 1"]),
    );
  });

  test("logs are Powertools JSON with the correlation and trace IDs, and are not repeated on replay", async () => {
    const payload = input(await seedNote());
    // Powertools writes one JSON object per line to stdout. (mockRestore clears recorded calls,
    // so lines are collected as they are written.)
    const written: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => written.push(String(chunk)) > 0);
    try {
      await new LocalDurableTestRunner({ handlerFunction: handler }).run({ payload });
    } finally {
      stdout.mockRestore();
    }

    const entries = written
      .filter((line) => line.includes(payload.correlationId))
      .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line) as unknown));
    // Two invocations ran, but the pre-wait line is suppressed when the second one replays it.
    expect(entries.map((entry) => entry["message"])).toEqual(["grace period started", "archive-note finished"]);
    const traceId = spans.getFinishedSpans()[0]?.spanContext().traceId;
    for (const entry of entries) {
      expect(entry).toMatchObject({ correlationId: payload.correlationId, noteId: payload.noteId, traceId });
      expect(entry["executionArn"]).toEqual(expect.any(String));
    }
  });
});
