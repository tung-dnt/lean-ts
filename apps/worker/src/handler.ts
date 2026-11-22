import { Logger } from "@aws-lambda-powertools/logger";
import { z } from "zod";

import { connect } from "@lean-ts/db";
import { loadConfig } from "@lean-ts/platform";

import { createArchiveHandler } from "./archive.ts";

// Cold start: config and one pooled connection per execution environment.
const config = loadConfig(z.object({ DATABASE_URL: z.string().min(1) }));
const { db } = connect(config.DATABASE_URL, { max: 1 });

/** SQS event source with `ReportBatchItemFailures`. */
export const handler = createArchiveHandler({
  db,
  logger: new Logger({ serviceName: "worker" }),
  now: () => new Date(),
});
