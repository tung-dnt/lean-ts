import { randomUUID } from "node:crypto";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { Wait } from "testcontainers";

import { connect, type Database } from "./client.ts";
import { runMigrations } from "./migrate.ts";

/** Test-only entry point (`@lean-ts/db/testing`): Vitest global setup plus helpers. */

/** The URL the global setup prepared; fails fast when a test runs without it. */
export function testDatabaseUrl(): string {
  const url = process.env["TEST_DATABASE_URL"];
  if (url === undefined || url === "") throw new Error("TEST_DATABASE_URL is not set: add the db global setup");
  return url;
}

/** Empties every application table between tests. */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(sql`truncate notes, processed_messages`);
}

/**
 * Vitest global setup. Tests run against real PostgreSQL with the real migrations, in a
 * database created for this run and dropped afterwards, so packages can test in parallel
 * against one server. TEST_DATABASE_URL names that server (e.g. a CI service container;
 * the role needs CREATEDB); without it a container starts. Never point it at a shared or
 * live server.
 */
export default async function setup(): Promise<() => Promise<void>> {
  let container: StartedPostgreSqlContainer | undefined;
  let serverUrl = process.env["TEST_DATABASE_URL"];
  if (serverUrl === undefined || serverUrl === "") {
    // The image's health check (pg_isready) is enough. The default strategy also probes the
    // port with `docker exec`, which hangs on some local runtimes (Kiri).
    container = await new PostgreSqlContainer("postgres:17-alpine").withWaitStrategy(Wait.forHealthCheck()).start();
    serverUrl = container.getConnectionUri();
  }

  const name = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = connect(serverUrl);
  await admin.db.execute(sql.raw(`create database ${name}`));
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  process.env["TEST_DATABASE_URL"] = url.toString();
  await runMigrations(url.toString());

  return async () => {
    await admin.db.execute(sql.raw(`drop database ${name} with (force)`));
    await admin.close();
    await container?.stop();
  };
}
