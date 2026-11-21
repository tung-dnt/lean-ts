import { z } from "zod";

export const NOTE_TITLE_MAX = 200;
export const NOTE_BODY_MAX = 10_000;

/** Input accepted from any boundary (HTTP body, queue message, form). */
export const newNoteInput = z.strictObject({
  title: z.string().trim().min(1, "title is required").max(NOTE_TITLE_MAX),
  body: z.string().max(NOTE_BODY_MAX).default(""),
});
export type NewNoteInput = z.input<typeof newNoteInput>;

export type NoteStatus = "active" | "archived";

export interface Note {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: NoteStatus;
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
}

export type NoteError =
  | { readonly kind: "invalid"; readonly issues: readonly string[] }
  | { readonly kind: "already-archived"; readonly id: string };

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * Builds a new note from untrusted input. The caller supplies the id and clock
 * so this stays pure and deterministic in tests.
 */
export function createNote(input: unknown, id: string, now: Date): Result<Note, NoteError> {
  const parsed = newNoteInput.safeParse(input);
  if (!parsed.success) {
    return err({ kind: "invalid", issues: parsed.error.issues.map((issue) => issue.message) });
  }
  return ok({
    id,
    title: parsed.data.title,
    body: parsed.data.body,
    status: "active",
    createdAt: now,
    archivedAt: null,
  });
}

/** Archiving is a one-way transition; archiving twice is reported, not ignored. */
export function archiveNote(note: Note, now: Date): Result<Note, NoteError> {
  if (note.status === "archived") {
    return err({ kind: "already-archived", id: note.id });
  }
  return ok({ ...note, status: "archived", archivedAt: now });
}
