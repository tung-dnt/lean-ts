import { randomUUID } from "node:crypto";

import { Logger } from "@aws-lambda-powertools/logger";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";

import { connect } from "@lean-ts/db";
import { resolveDatabaseUrl } from "@lean-ts/platform";

import { createRoutes } from "./routes.ts";

// Cold start: resolve the database URL once and keep one pooled connection per container.
// Lambda runs one request at a time per container, so the pool holds one client.
const logger = new Logger({ serviceName: "api" });
const { db } = connect(await resolveDatabaseUrl(), { max: 1 });
const app = createRoutes({ db, logger, now: () => new Date(), newId: randomUUID });

/** API Gateway HTTP API (payload v2), one Lambda for all routes. */
export const handler = async (event: APIGatewayProxyEventV2, context: Context) => {
  logger.addContext(context);
  return await app.resolve(event, context);
};
