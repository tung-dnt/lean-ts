import {
  createPowertoolsLogger,
  withDurableExecution,
  type DurableContext,
  type DurableExecutionConfig,
} from "@aws/durable-execution-sdk-js";
import type { Logger } from "@aws-lambda-powertools/logger";
import { trace } from "@opentelemetry/api";
import { z } from "zod";

import { findNote, findNoteForUpdate, inTransaction, saveNote, type Database } from "@lean-ts/db";
import { archiveNote } from "@lean-ts/domain-note";

import { stepPolicy } from "./step-policy.ts";

/** Workflow name: the Workflow span name, and the key dashboards group by. */
export const ARCHIVE_NOTE_WORKFLOW = "archive-note";

export const archiveNoteInput = z.strictObject({
  noteId: z.uuid(),
  /** Also the durable execution name the caller starts the run with: one run per ID. */
  correlationId: z.uuid(),
  /** Grace period before archiving; the run is suspended (no compute billed) meanwhile. */
  graceSeconds: z.int().min(1).max(86_400),
});

export type ArchiveNoteOutcome = "archived" | "already-archived" | "missing";

/**
 * A durable workflow: check the note, wait out the grace period, archive it.
 *
 * Replay rules (the code runs again from the top after every wait or retry):
 * - everything with a side effect or a clock read happens inside `context.step`;
 * - step names are a contract with runs in flight: renaming one breaks them;
 * - steps return IDs and outcomes only, never note content, because results are stored
 *   in the execution history;
 * - every step declares its effect, retries and idempotency guard with `stepPolicy`.
 *
 * `withDurableExecution` wraps the handler inline, in this file: `vp run workflows:graph`
 * (durable-viz) draws the graph from it and only reads the file that makes that call.
 */
export function archiveNoteWorkflow(deps: {
  readonly db: Database;
  readonly log: Logger;
  readonly now: () => Date;
  readonly plugins: NonNullable<DurableExecutionConfig["plugins"]>;
}) {
  return withDurableExecution(
    async (event: unknown, context: DurableContext): Promise<{ outcome: ArchiveNoteOutcome }> => {
      // Replay-aware: lines written before a wait are not repeated when the run resumes.
      context.configureLogger({ customLogger: createPowertoolsLogger(deps.log) });
      const input = archiveNoteInput.parse(event);
      const fields = { correlationId: input.correlationId, noteId: input.noteId };

      const exists = await context.step(
        "check-note",
        async () => {
          tagSpan(fields);
          return (await findNote(deps.db, input.noteId)) !== undefined;
        },
        stepPolicy({ effect: "read", retry: "transient" }),
      );
      if (!exists) {
        context.logger.warn("note not found; nothing to archive", fields);
        return { outcome: "missing" };
      }

      context.logger.info("grace period started", { ...fields, graceSeconds: input.graceSeconds });
      await context.wait("grace-period", { seconds: input.graceSeconds });

      const outcome = await context.step(
        "archive",
        async () => {
          tagSpan(fields);
          return await archiveNoteById(deps, input.noteId);
        },
        stepPolicy({ effect: "write", guard: "row-lock", retry: "transient" }),
      );

      context.logger.info("archive-note finished", { ...fields, outcome });
      return { outcome };
    },
    { plugins: deps.plugins },
  );
}

/**
 * The `archive` step's effect. Safe to run again, and by two executions at once: the row is
 * locked for the transaction, and an already archived note is reported, not archived again.
 */
export async function archiveNoteById(
  deps: { readonly db: Database; readonly now: () => Date },
  noteId: string,
): Promise<ArchiveNoteOutcome> {
  return await inTransaction(deps.db, async (tx): Promise<ArchiveNoteOutcome> => {
    const note = await findNoteForUpdate(tx, noteId);
    if (note === undefined) return "missing";
    const archived = archiveNote(note, deps.now());
    if (!archived.ok) return "already-archived";
    await saveNote(tx, archived.value);
    return "archived";
  });
}

/**
 * Puts the correlation ID on the active step-attempt span, so Transaction Search finds
 * every run of a request by `correlation.id`. Inside a step the attempt span is active;
 * the Workflow span is not recording until the run ends, so it can't carry the attribute.
 */
function tagSpan(fields: { correlationId: string; noteId: string }): void {
  trace.getActiveSpan()?.setAttributes({ "correlation.id": fields.correlationId, "note.id": fields.noteId });
}
