import { z } from "zod";

import { claimMessage, findNoteForUpdate, inTransaction, saveNote, type Database } from "@lean-ts/db";
import { archiveNote } from "@lean-ts/domain-note";
import type { MessageHandler } from "@lean-ts/platform";

export const archiveMessage = z.strictObject({ noteId: z.uuid() });

/**
 * Archives one note per message. The claim, the row lock and the update share one
 * transaction, so a redelivered message is a no-op and a crash mid-way leaves nothing
 * claimed. A malformed message throws: SQS retries it, then moves it to the DLQ.
 */
export function createArchiveHandler(deps: { readonly db: Database; readonly now: () => Date }): MessageHandler {
  return async (message) => {
    const { noteId } = archiveMessage.parse(message.body);
    const log = message.log.with({ noteId });

    await inTransaction(deps.db, async (tx) => {
      if (!(await claimMessage(tx, message.messageId))) {
        log.info("duplicate message skipped");
        return;
      }
      const note = await findNoteForUpdate(tx, noteId);
      if (note === undefined) {
        log.warn("note not found; message dropped");
        return;
      }
      const archived = archiveNote(note, deps.now());
      if (!archived.ok) {
        log.info("note already archived");
        return;
      }
      await saveNote(tx, archived.value);
      log.info("note archived");
    });
  };
}
