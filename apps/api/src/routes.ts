import { z } from "zod";

import { findNote, insertNote, listNotes, type Database } from "@lean-ts/db";
import { createNote } from "@lean-ts/domain-note";
import { json, problem, type HttpHandler, type HttpRequest, type HttpResponse } from "@lean-ts/platform";

export interface Deps {
  readonly db: Database;
  readonly now: () => Date;
  readonly newId: () => string;
}

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
const noteId = z.uuid();

/** Routes are keyed by API Gateway route key ("METHOD /path/{param}"). */
export function createRoutes(deps: Deps): Record<string, (request: HttpRequest) => Promise<HttpResponse>> {
  return {
    "POST /notes": async (request) => {
      const result = createNote(request.body, deps.newId(), deps.now());
      if (!result.ok) {
        return problem(422, "Invalid note", result.error);
      }
      await insertNote(deps.db, result.value);
      request.log.info("note created", { noteId: result.value.id });
      return json(201, result.value);
    },

    "GET /notes": async (request) => {
      const query = listQuery.safeParse(request.query);
      if (!query.success) {
        return problem(400, "Invalid query", z.flattenError(query.error).fieldErrors);
      }
      return json(200, await listNotes(deps.db, { limit: query.data.limit }));
    },

    "GET /notes/{id}": async (request) => {
      const id = noteId.safeParse(request.pathParams["id"]);
      if (!id.success) {
        return problem(404, "Note not found");
      }
      const found = await findNote(deps.db, id.data);
      return found === undefined ? problem(404, "Note not found") : json(200, found);
    },
  };
}

export function createRouter(deps: Deps): HttpHandler {
  const routes = createRoutes(deps);
  return async (request: HttpRequest) => {
    const route = routes[request.routeKey];
    return route === undefined ? problem(404, "No such route") : await route(request);
  };
}
