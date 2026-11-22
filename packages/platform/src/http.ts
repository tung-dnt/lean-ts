import { randomUUID } from "node:crypto";

import { Router } from "@aws-lambda-powertools/event-handler/http";
import type { Logger } from "@aws-lambda-powertools/logger";
import { z } from "zod";

export const CORRELATION_HEADER = "x-correlation-id";

const correlationId = z.uuid();

/**
 * The HTTP API router every app starts from: Powertools Event Handler (API Gateway HTTP
 * API v2, REST v1, ALB). Routes declare zod schemas in `validation.req` (body, query,
 * path, headers); the router validates before the handler runs, answers 422 with the
 * issues, and types `reqCtx.valid.req`. Unmatched routes get 404, unhandled errors 500
 * without internals.
 *
 * Added here: one correlation ID per request. A caller's `x-correlation-id` is kept when
 * it is a UUID (anything else is replaced, so log lines can't be forged), set as the
 * logger's `correlation_id`, and echoed on the response.
 */
export function createHttpRouter(logger: Logger): Router {
  const app = new Router({ logger });
  app.use(async ({ reqCtx, next }) => {
    const incoming = reqCtx.req.headers.get(CORRELATION_HEADER);
    const id = correlationId.safeParse(incoming).success && incoming !== null ? incoming : randomUUID();
    logger.setCorrelationId(id);
    try {
      await next();
    } finally {
      // Also on 4xx/5xx: validation and handler errors throw through here.
      reqCtx.res.headers.set(CORRELATION_HEADER, id);
    }
  });
  return app;
}
