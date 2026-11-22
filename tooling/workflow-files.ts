/**
 * Shared by the workflow scripts (workflow-graph.ts, workflow-contract.ts): which files are
 * durable workflows, which changed on a branch, and how to replace a section of a PR body.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const run = (command: string, argv: readonly string[], input?: string): string =>
  execFileSync(command, argv, { encoding: "utf8", stdio: "pipe", ...(input === undefined ? {} : { input }) });

/** The convention: a workflow file calls `withDurableExecution(` with the handler inline. */
export const isWorkflow = (source: string): boolean => source.includes("withDurableExecution(");

/** Tracked and new (not ignored) files matching `patterns`; a tracked file deleted in the working tree is skipped. */
export function listFiles(patterns: readonly string[]): string[] {
  const paths = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", ...patterns])
    .split("\n")
    .filter((path) => path !== "" && existsSync(path));
  return [...new Set(paths)];
}

export function workflowFiles(): string[] {
  return listFiles(["apps/*/src/*.ts", "apps/*/src/**/*.ts"]).filter((path) => isWorkflow(readFileSync(path, "utf8")));
}

/** The merge base with `base`, and the files changed since it. */
export function changedSince(base: string): { mergeBase: string; changed: ReadonlySet<string> } {
  const mergeBase = run("git", ["merge-base", base, "HEAD"]).trim();
  return { mergeBase, changed: new Set(run("git", ["diff", "--name-only", mergeBase, "HEAD"]).split("\n")) };
}

/**
 * Replaces the text between `start` and `end` in PR `pr`'s body with `markdown` (markers
 * included), keeps the rest, and removes the section when `markdown` is empty. Needs `gh`.
 */
export function replacePrSection(pr: string, start: string, end: string, markdown: string): void {
  const body = run("gh", ["pr", "view", pr, "--json", "body", "--jq", ".body"]);
  const at = body.indexOf(start);
  const until = body.indexOf(end);
  const kept =
    at === -1 || until === -1 ? body.trimEnd() : `${body.slice(0, at)}${body.slice(until + end.length)}`.trimEnd();
  const next = markdown === "" ? kept : `${kept}\n\n${markdown}`;
  if (next.trim() !== body.trim()) run("gh", ["pr", "edit", pr, "--body-file", "-"], next);
}
