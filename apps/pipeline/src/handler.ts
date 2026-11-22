import { createOtelPluginFactory } from "@aws/durable-execution-sdk-js-otel";
import { Logger } from "@aws-lambda-powertools/logger";

import { connect } from "@lean-ts/db";
import { resolveDatabaseUrl } from "@lean-ts/platform";

import { ARCHIVE_NOTE_WORKFLOW, archiveNoteWorkflow } from "./archive-note.ts";

// Cold start: database URL once, one pooled connection per execution environment.
const { db } = connect(await resolveDatabaseUrl(), { max: 1 });

// Spans go to the global OpenTelemetry provider, which the ADOT / Application Signals
// layer registers (AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument). Without the layer the
// plugin finds no provider and the workflow runs untraced.
export const handler = archiveNoteWorkflow({
  db,
  log: new Logger({ serviceName: "pipeline" }),
  now: () => new Date(),
  plugins: [createOtelPluginFactory({ workflowSpanName: ARCHIVE_NOTE_WORKFLOW })],
});
