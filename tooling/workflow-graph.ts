/**
 * Draws every durable workflow as a Mermaid flowchart, from source, with durable-viz
 * (static analysis: nothing is imported or run). Output is one Markdown section for a
 * PR body; GitHub renders the `mermaid` blocks.
 *
 *   node tooling/workflow-graph.ts                      all workflows, to stdout
 *   node tooling/workflow-graph.ts --base origin/main   only workflows changed since the
 *                                                       merge base, before and after
 *   node tooling/workflow-graph.ts --base origin/main --pr 12
 *                                                       also replace the section in PR #12's
 *                                                       body (needs `gh` and GH_TOKEN)
 *
 * A workflow is a file under apps/*\/src that calls `withDurableExecution(` with the
 * handler inline. Exits 1 when durable-viz cannot draw a workflow, after writing the rest.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import { changedSince, isWorkflow, replacePrSection, run, workflowFiles } from "./workflow-files.ts";

const START = "<!-- workflow-graphs:start -->";
const END = "<!-- workflow-graphs:end -->";
const durableViz = join(import.meta.dirname, "..", "node_modules", ".bin", "durable-viz");

const { values: args } = parseArgs({ options: { base: { type: "string" }, pr: { type: "string" } } });

type Drawing = { ok: true; mermaid: string } | { ok: false; error: string };

/** Mermaid from durable-viz, minus its `click … call` lines: they target durable-viz's own HTML viewer. */
function draw(file: string, name: string): Drawing {
  try {
    const mermaid = run(durableViz, [file, "--name", name, "--direction", "TD"]);
    return {
      ok: true,
      mermaid: mermaid
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("click "))
        .join("\n")
        .trim(),
    };
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    return { ok: false, error: stderr === "" ? String(error) : stderr };
  }
}

/** Draws a file as it was at `ref`, via a temporary copy (imports are never resolved). */
function drawAt(ref: string, path: string, scratch: string): Drawing | undefined {
  let source: string;
  try {
    source = run("git", ["show", `${ref}:${path}`]);
  } catch {
    return undefined; // the file is new on this branch
  }
  if (!isWorkflow(source)) return undefined;
  const copy = join(scratch, basename(path));
  writeFileSync(copy, source);
  return draw(copy, basename(path, ".ts"));
}

const block = (result: Drawing): string =>
  result.ok
    ? `\`\`\`mermaid\n${result.mermaid}\n\`\`\``
    : `> ⚠ durable-viz could not draw this file:\n> ${result.error}`;

const workflows = workflowFiles();

let mergeBase: string | undefined;
let selected = workflows;
if (args.base !== undefined) {
  const since = changedSince(args.base);
  mergeBase = since.mergeBase;
  selected = workflows.filter((path) => since.changed.has(path));
}

const scratch = mkdtempSync(join(tmpdir(), "workflow-graph-"));
const drawn = selected.map((path) => ({
  path,
  after: draw(path, basename(path, ".ts")),
  before: mergeBase === undefined ? undefined : drawAt(mergeBase, path, scratch),
}));
rmSync(scratch, { recursive: true, force: true });

const sections = drawn.map(({ path, after, before }) => {
  const title = `### \`${path}\``;
  if (mergeBase === undefined) return `${title}\n\n${block(after)}`;
  if (before === undefined) return `${title} (new)\n\n${block(after)}`;
  if (before.ok && after.ok && before.mermaid === after.mermaid)
    return `${title}\n\nCode changed; the graph did not.\n\n${block(after)}`;
  return `${title}\n\n<details><summary>Before</summary>\n\n${block(before)}\n\n</details>\n\n**After**\n\n${block(after)}`;
});

const markdown =
  sections.length === 0
    ? ""
    : [
        START,
        "## Workflow graphs",
        "",
        "_Generated from source by `vp run workflows:graph` (durable-viz). It draws durable operations only: an `if` or `return` with no durable call inside is not shown. Review the code for those paths._",
        "",
        sections.join("\n\n"),
        END,
      ].join("\n");

if (args.pr === undefined) {
  process.stdout.write(markdown === "" ? "No workflow graphs to show.\n" : `${markdown}\n`);
} else {
  replacePrSection(args.pr, START, END, markdown);
  process.stdout.write(`PR #${args.pr}: ${sections.length} workflow graph(s) in the body.\n`);
}

process.exitCode = drawn.some(({ after }) => !after.ok) ? 1 : 0;
