import type { Logger } from "@aws-lambda-powertools/logger";
import { z } from "zod";

import { claimMessage, findNoteForUpdate, inTransaction, saveNote, type Database } from "@lean-ts/db";
import { archiveNote } from "@lean-ts/domain-note";
import { sqsBatchHandler } from "@lean-ts/platform";

/** The queue's message contract. Powertools validates every record's body against it. */
export const archiveMessage = z.strictObject({ noteId: z.uuid() });

/**
 * Archives one note per message. A malformed body never reaches this code: the batch
 * processor reports it as failed, SQS retries it, then moves it to the DLQ. The claim,
 * the row lock and the update share one transaction, so a redelivered message is a
 * no-op and a crash mid-way leaves nothing claimed.
 */
export function createArchiveHandler(deps: {
  readonly db: Database;
  readonly logger: Logger;
  readonly now: () => Date;
}) {
  const { logger } = deps;
  return sqsBatchHandler({
    schema: archiveMessage,
    logger,
    handle: async ({ messageId, body: { noteId } }) => {
      await inTransaction(deps.db, async (tx) => {
        if (!(await claimMessage(tx, messageId))) {
          logger.info("duplicate message skipped", { messageId, noteId });
          return;
        }
        const note = await findNoteForUpdate(tx, noteId);
        if (note === undefined) {
          logger.warn("note not found; message dropped", { messageId, noteId });
          return;
        }
        const archived = archiveNote(note, deps.now());
        if (!archived.ok) {
          logger.info("note already archived", { messageId, noteId });
          return;
        }
        await saveNote(tx, archived.value);
        logger.info("note archived", { messageId, noteId });
      });
    },
  });
}
