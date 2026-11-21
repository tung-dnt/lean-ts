import { z } from "zod";

import { connect } from "@lean-ts/db";
import { createLogger, loadConfig, sqsLambda } from "@lean-ts/platform";

import { createArchiveHandler } from "./archive.ts";

// Cold start: config and one pooled connection per execution environment.
const config = loadConfig(z.object({ DATABASE_URL: z.string().min(1) }));
const log = createLogger({ base: { service: "worker" } });
const { db } = connect(config.DATABASE_URL, { max: 1 });

export const handler = sqsLambda(createArchiveHandler({ db, now: () => new Date() }), log);
