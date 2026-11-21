import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { connect } from "./client.ts";

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies every migration not yet recorded in the database. A deploy step, never a Lambda cold start. */
export async function runMigrations(connectionString: string): Promise<void> {
  const handle = connect(connectionString);
  try {
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await handle.close();
  }
}
