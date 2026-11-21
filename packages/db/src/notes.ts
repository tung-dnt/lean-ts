import { desc, eq } from "drizzle-orm";

import type { Note } from "@lean-ts/domain-note";

import type { Executor } from "./client.ts";
import { notes, processedMessages } from "./schema.ts";

type NoteRow = typeof notes.$inferSelect;

const toNote = (row: NoteRow): Note => ({
  id: row.id,
  title: row.title,
  body: row.body,
  status: row.status,
  createdAt: row.createdAt,
  archivedAt: row.archivedAt,
});

export async function insertNote(db: Executor, note: Note): Promise<void> {
  await db.insert(notes).values(note);
}

export async function findNote(db: Executor, id: string): Promise<Note | undefined> {
  const [row] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  return row === undefined ? undefined : toNote(row);
}

/** Locks the row until the surrounding transaction ends, so concurrent writers queue up. */
export async function findNoteForUpdate(tx: Executor, id: string): Promise<Note | undefined> {
  const [row] = await tx.select().from(notes).where(eq(notes.id, id)).limit(1).for("update");
  return row === undefined ? undefined : toNote(row);
}

export async function listNotes(db: Executor, options: { limit: number }): Promise<Note[]> {
  const rows = await db.select().from(notes).orderBy(desc(notes.createdAt)).limit(options.limit);
  return rows.map(toNote);
}

export async function saveNote(db: Executor, note: Note): Promise<void> {
  await db
    .update(notes)
    .set({ title: note.title, body: note.body, status: note.status, archivedAt: note.archivedAt })
    .where(eq(notes.id, note.id));
}

/**
 * Records that `messageId` is being handled. Returns false when it was handled before,
 * so the caller skips the work. Call it inside the same transaction as the work: if the
 * work fails, the record rolls back with it and the redelivered message runs again.
 */
export async function claimMessage(tx: Executor, messageId: string): Promise<boolean> {
  const claimed = await tx
    .insert(processedMessages)
    .values({ messageId })
    .onConflictDoNothing()
    .returning({ messageId: processedMessages.messageId });
  return claimed.length === 1;
}
