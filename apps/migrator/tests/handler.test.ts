import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "vite-plus/test";

import { connect, listNotes, migrationsFolder, runMigrations } from "@lean-ts/db";
import { testDatabaseUrl } from "@lean-ts/db/testing";

// The bundle passes its copied folder to runMigrations; prove a copy applies cleanly and
// that a second run is a no-op (the Trigger runs on every deploy).
const copy = mkdtempSync(join(tmpdir(), "migrations-"));
cpSync(migrationsFolder, copy, { recursive: true });

afterAll(() => {
  rmSync(copy, { recursive: true, force: true });
});

test("applies a copied migrations folder, and a second run changes nothing", async () => {
  await runMigrations(testDatabaseUrl(), copy);
  await runMigrations(testDatabaseUrl(), copy);
  const handle = connect(testDatabaseUrl());
  try {
    expect(await listNotes(handle.db, { limit: 1 })).toEqual([]);
  } finally {
    await handle.close();
  }
});
