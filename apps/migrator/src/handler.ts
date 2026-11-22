import { fileURLToPath } from "node:url";

import { Logger } from "@aws-lambda-powertools/logger";

import { runMigrations } from "@lean-ts/db";
import { resolveDatabaseUrl } from "@lean-ts/platform";

const logger = new Logger({ serviceName: "migrator" });

/** In the bundle the migrations are copied to `dist/migrations`, next to this file. */
const bundledMigrations = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * Applies pending migrations, then returns. CDK's Trigger invokes it during deploy,
 * before the API, worker and pipeline functions are updated; a failure fails the deploy.
 */
export async function handler(): Promise<{ applied: true }> {
  await runMigrations(await resolveDatabaseUrl(), bundledMigrations);
  logger.info("migrations applied");
  return { applied: true };
}
