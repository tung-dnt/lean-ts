import { describe, expect, test } from "vite-plus/test";

import { NOTE_TITLE_MAX, archiveNote, createNote } from "../src/index.ts";

const now = new Date("2026-01-01T09:00:00Z");

describe("createNote", () => {
  test("trims the title and defaults the body", () => {
    const result = createNote({ title: "  Ward round  " }, "n-1", now);
    expect(result).toEqual({
      ok: true,
      value: { id: "n-1", title: "Ward round", body: "", status: "active", createdAt: now, archivedAt: null },
    });
  });

  test("rejects a blank title", () => {
    const result = createNote({ title: "   " }, "n-1", now);
    expect(result).toEqual({ ok: false, error: { kind: "invalid", issues: ["title is required"] } });
  });

  test("rejects a title over the limit", () => {
    const result = createNote({ title: "x".repeat(NOTE_TITLE_MAX + 1) }, "n-1", now);
    expect(result.ok).toBe(false);
  });

  test("rejects unknown fields so typos are not silently dropped", () => {
    const result = createNote({ title: "a", bdoy: "typo" }, "n-1", now);
    expect(result.ok).toBe(false);
  });
});

describe("archiveNote", () => {
  test("archives an active note once", () => {
    const created = createNote({ title: "a" }, "n-1", now);
    if (!created.ok) throw new Error("setup failed");
    const later = new Date("2026-01-02T09:00:00Z");

    const archived = archiveNote(created.value, later);
    expect(archived).toMatchObject({ ok: true, value: { status: "archived", archivedAt: later } });
    if (!archived.ok) throw new Error("archive failed");

    expect(archiveNote(archived.value, later)).toEqual({ ok: false, error: { kind: "already-archived", id: "n-1" } });
  });
});
