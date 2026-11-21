import { useState, type SubmitEvent } from "react";
import { z } from "zod";

import { NOTE_TITLE_MAX, newNoteInput } from "@lean-ts/domain-note";

const savedNote = z.object({ id: z.string() });

type Status = { kind: "idle" } | { kind: "error"; message: string } | { kind: "saved"; id: string };

/**
 * The browser validates with the same zod schema the API enforces, imported from the
 * domain package. The API still validates: the browser check is for the user, not trust.
 */
export function App() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = newNoteInput.safeParse({ title, body });
    if (!parsed.success) {
      setStatus({ kind: "error", message: parsed.error.issues.map((issue) => issue.message).join("; ") });
      return;
    }
    const response = await fetch("/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
    if (!response.ok) {
      setStatus({ kind: "error", message: `Save failed (${String(response.status)})` });
      return;
    }
    const saved = savedNote.parse(await response.json());
    setStatus({ kind: "saved", id: saved.id });
    setTitle("");
    setBody("");
  }

  return (
    <main>
      <h1>New note</h1>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Title
          <input value={title} maxLength={NOTE_TITLE_MAX} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          Body
          <textarea value={body} onChange={(event) => setBody(event.target.value)} />
        </label>
        <button type="submit">Save</button>
      </form>
      {status.kind === "error" && <p role="alert">{status.message}</p>}
      {status.kind === "saved" && <output>Saved note {status.id}</output>}
    </main>
  );
}
