import { Logger } from "@aws-lambda-powertools/logger";

import { connect } from "@lean-ts/db";
import { resolveDatabaseUrl } from "@lean-ts/platform";

import { createArchiveHandler } from "./archive.ts";

// Cold start: database URL once, one pooled connection per execution environment.
const { db } = connect(await resolveDatabaseUrl(), { max: 1 });

/** SQS event source with `ReportBatchItemFailures`. */
export const handler = createArchiveHandler({
  db,
  logger: new Logger({ serviceName: "worker" }),
  now: () => new Date(),
});
