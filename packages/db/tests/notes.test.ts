import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createNote, type Note } from "@lean-ts/domain-note";

import { claimMessage, connect, findNote, inTransaction, insertNote, listNotes, saveNote } from "../src/index.ts";
import { testDatabaseUrl, truncateAll } from "../src/testing.ts";

const handle = connect(testDatabaseUrl(), { max: 4 });
const { db } = handle;

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

function note(title: string, createdAt: Date): Note {
  const result = createNote({ title }, randomUUID(), createdAt);
  if (!result.ok) throw new Error(`invalid fixture: ${title}`);
  return result.value;
}

describe("notes", () => {
  test("round-trips a note, keeping the instant of timestamptz columns", async () => {
    const created = note("Ward round", new Date("2026-03-29T00:30:00Z")); // the night UK clocks change
    await insertNote(db, created);
    expect(await findNote(db, created.id)).toEqual(created);
  });

  test("lists newest first and honours the limit", async () => {
    const older = note("older", new Date("2026-01-01T00:00:00Z"));
    const newer = note("newer", new Date("2026-01-02T00:00:00Z"));
    await insertNote(db, older);
    await insertNote(db, newer);
    expect((await listNotes(db, { limit: 1 })).map((n) => n.title)).toEqual(["newer"]);
  });

  test("rolls the whole transaction back when the work throws", async () => {
    const created = note("draft", new Date("2026-01-01T00:00:00Z"));
    await expect(
      inTransaction(db, async (tx) => {
        await insertNote(tx, created);
        throw new Error("fail after insert");
      }),
    ).rejects.toThrow("fail after insert");
    expect(await findNote(db, created.id)).toBeUndefined();
  });
});

describe("claimMessage", () => {
  test("claims a message once; a redelivery is refused", async () => {
    expect(await inTransaction(db, async (tx) => await claimMessage(tx, "m-1"))).toBe(true);
    expect(await inTransaction(db, async (tx) => await claimMessage(tx, "m-1"))).toBe(false);
  });

  test("a claim made in a failed transaction is released, so the redelivery runs", async () => {
    const created = note("to archive", new Date("2026-01-01T00:00:00Z"));
    await insertNote(db, created);

    await expect(
      inTransaction(db, async (tx) => {
        await claimMessage(tx, "m-2");
        await saveNote(tx, { ...created, status: "archived", archivedAt: new Date() });
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow("crash before commit");

    expect((await findNote(db, created.id))?.status).toBe("active");
    expect(await inTransaction(db, async (tx) => await claimMessage(tx, "m-2"))).toBe(true);
  });
});
