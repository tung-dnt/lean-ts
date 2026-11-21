import type { SQSEvent, SQSRecord } from "aws-lambda";
import { afterAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { connect, findNote, insertNote } from "@lean-ts/db";
import { testDatabaseUrl, truncateAll } from "@lean-ts/db/testing";
import { createNote, type Note } from "@lean-ts/domain-note";
import { createLogger, sqsLambda } from "@lean-ts/platform";

import { createArchiveHandler } from "../src/archive.ts";

const handle = connect(testDatabaseUrl(), { max: 2 });
const archivedAt = new Date("2026-11-21T12:00:00.000Z");
const handler = sqsLambda(
  createArchiveHandler({ db: handle.db, now: () => archivedAt }),
  createLogger({ sink: () => {} }),
);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await truncateAll(handle.db);
});

async function seedNote(id: string): Promise<Note> {
  const result = createNote({ title: "Discharge summary" }, id, new Date("2026-11-20T00:00:00.000Z"));
  if (!result.ok) throw new Error("fixture note is invalid");
  await insertNote(handle.db, result.value);
  return result.value;
}

function batch(...records: { messageId: string; body: string }[]): SQSEvent {
  return {
    Records: records.map(({ messageId, body }): SQSRecord => ({
      messageId,
      body,
      receiptHandle: "rh",
      attributes: {
        ApproximateReceiveCount: "1",
        SentTimestamp: "0",
        SenderId: "s",
        ApproximateFirstReceiveTimestamp: "0",
      },
      messageAttributes: {},
      md5OfBody: "",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:eu-west-2:1:notes",
      awsRegion: "eu-west-2",
    })),
  };
}

const NOTE_A = "00000000-0000-4000-8000-00000000000a";
const NOTE_B = "00000000-0000-4000-8000-00000000000b";

describe("archive worker", () => {
  test("archives the note and treats a redelivery as a no-op", async () => {
    await seedNote(NOTE_A);
    const message = { messageId: "m-1", body: JSON.stringify({ noteId: NOTE_A }) };

    expect(await handler(batch(message))).toEqual({ batchItemFailures: [] });
    expect(await findNote(handle.db, NOTE_A)).toMatchObject({ status: "archived", archivedAt });

    expect(await handler(batch(message))).toEqual({ batchItemFailures: [] });
    expect(await findNote(handle.db, NOTE_A)).toMatchObject({ status: "archived", archivedAt });
  });

  test("reports only the malformed record, and the rest of the batch still commits", async () => {
    await seedNote(NOTE_B);
    const result = await handler(
      batch(
        { messageId: "bad", body: JSON.stringify({ noteId: "nope" }) },
        { messageId: "good", body: JSON.stringify({ noteId: NOTE_B }) },
      ),
    );
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "bad" }] });
    expect(await findNote(handle.db, NOTE_B)).toMatchObject({ status: "archived" });
  });

  test("drops a message for a note that does not exist", async () => {
    const result = await handler(batch({ messageId: "m-2", body: JSON.stringify({ noteId: NOTE_A }) }));
    expect(result).toEqual({ batchItemFailures: [] });
  });
});
