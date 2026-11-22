import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { connect } from "./client.ts";

/** The migrations next to this package's source; a bundle passes its own copied folder. */
export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies every migration not yet recorded in the database. A deploy step (the
 * `apps/migrator` Lambda, run by CDK before the app functions update), never a Lambda cold start.
 */
export async function runMigrations(connectionString: string, folder: string = migrationsFolder): Promise<void> {
  const handle = connect(connectionString);
  try {
    await migrate(handle.db, { migrationsFolder: folder });
  } finally {
    await handle.close();
  }
}
