import { createOtelPluginFactory } from "@aws/durable-execution-sdk-js-otel";
import { z } from "zod";

import { connect } from "@lean-ts/db";
import { createLogger, loadConfig } from "@lean-ts/platform";

import { ARCHIVE_NOTE_WORKFLOW, archiveNoteWorkflow } from "./archive-note.ts";

// Cold start: config and one pooled connection per execution environment.
const config = loadConfig(z.object({ DATABASE_URL: z.string().min(1) }));
const { db } = connect(config.DATABASE_URL, { max: 1 });

// Spans go to the global OpenTelemetry provider, which the ADOT / Application Signals
// layer registers (AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument). Without the layer the
// plugin finds no provider and the workflow runs untraced.
export const handler = archiveNoteWorkflow({
  db,
  log: createLogger({ base: { service: "pipeline" } }),
  now: () => new Date(),
  plugins: [createOtelPluginFactory({ workflowSpanName: ARCHIVE_NOTE_WORKFLOW })],
});
