import { randomUUID } from "node:crypto";

import { z } from "zod";

import { connect } from "@lean-ts/db";
import { createLogger, httpLambda, loadConfig } from "@lean-ts/platform";

import { createRouter } from "./routes.ts";

// Cold start: read config once and keep one pooled connection per container.
// Lambda runs one request at a time per container, so the pool holds one client.
const config = loadConfig(z.object({ DATABASE_URL: z.string().min(1) }));
const log = createLogger({ base: { service: "api" } });
const { db } = connect(config.DATABASE_URL, { max: 1 });

export const handler = httpLambda(createRouter({ db, now: () => new Date(), newId: randomUUID }), log);
