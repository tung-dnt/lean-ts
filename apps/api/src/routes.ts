import { NotFoundError, type Router } from "@aws-lambda-powertools/event-handler/http";
import type { Logger } from "@aws-lambda-powertools/logger";
import { z } from "zod";

import { findNote, insertNote, listNotes, type Database } from "@lean-ts/db";
import { createNote, newNoteInput, type Note } from "@lean-ts/domain-note";
import { createHttpRouter } from "@lean-ts/platform";

export interface Deps {
  readonly db: Database;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly newId: () => string;
}

const listQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(20) });
const notePath = z.strictObject({ id: z.uuid() });

/** The JSON a client receives for a note (dates as ISO-8601 strings). Checked on the way out. */
export const noteResponse = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  status: z.enum(["active", "archived"]),
  createdAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});
export type NoteResponse = z.output<typeof noteResponse>;

const toResponse = (note: Note): NoteResponse => ({
  ...note,
  createdAt: note.createdAt.toISOString(),
  archivedAt: note.archivedAt?.toISOString() ?? null,
});

/**
 * The notes API. Each route binds zod schemas to the request and the response
 * (`validation`): the router rejects a bad body, query or path with 422 before the handler
 * runs, hands the handler typed values in `valid.req`, and answers 500 if the handler's
 * response breaks its schema. The body schema is the domain's own `newNoteInput`, so the
 * browser, the API and the domain share one definition.
 */
export function createRoutes(deps: Deps): Router {
  const app = createHttpRouter(deps.logger);

  app.post(
    "/notes",
    async ({ valid }) => {
      const result = createNote(valid.req.body, deps.newId(), deps.now());
      // The route validated with the same schema the domain uses, so this cannot happen.
      if (!result.ok) throw new Error("validated note input was rejected by the domain");
      await insertNote(deps.db, result.value);
      deps.logger.info("note created", { noteId: result.value.id });
      return { statusCode: 201, body: toResponse(result.value) };
    },
    { validation: { req: { body: newNoteInput }, res: { body: noteResponse } } },
  );

  app.get("/notes", async ({ valid }) => (await listNotes(deps.db, { limit: valid.req.query.limit })).map(toResponse), {
    validation: { req: { query: listQuery }, res: { body: z.array(noteResponse) } },
  });

  app.get(
    "/notes/:id",
    async ({ valid }) => {
      const note = await findNote(deps.db, valid.req.path.id);
      if (note === undefined) throw new NotFoundError("Note not found");
      return toResponse(note);
    },
    { validation: { req: { path: notePath }, res: { body: noteResponse } } },
  );

  return app;
}
