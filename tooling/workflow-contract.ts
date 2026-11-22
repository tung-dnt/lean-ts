/**
 * Prints each durable workflow's contract, read from source: for every operation its effect,
 * execution semantics, idempotency guard, retry policy, concurrency limit, what it reads and
 * where its result goes, plus a data-flow graph. Fails when a workflow breaks a contract rule.
 *
 *   node tooling/workflow-contract.ts                      every workflow, to stdout
 *   node tooling/workflow-contract.ts --base origin/main   cards for workflows changed since the merge base
 *   node tooling/workflow-contract.ts --base origin/main --pr 12
 *                                                          also replace the section in PR #12's body
 *
 * Rules, checked on every workflow (each breach is printed as path:line; exit 1 after the cards,
 * except with --pr, which only writes the body: the `ready` gate is what fails):
 * - every durable operation has a string-literal name: it is the replay contract and the card's key;
 * - every `context.step` passes `stepPolicy({ … })` with literal fields as its third argument;
 * - a write step that can run twice (any guard but `at-most-once`) has a test whose name contains
 *   `idempotent: <workflow>/<step>` in its app's tests/;
 * - `context.map` and `context.parallel` set `maxConcurrency` (the SDK default is unlimited);
 * - `waitForCallback` and `createCallback` set `serdes` (the default hands back the raw string);
 * - no `Promise.all`/`allSettled`/`race`/`any` outside a step: concurrent operations go through
 *   `context.parallel` or `context.map`, which name, limit and checkpoint them.
 *
 * Parsed with swc (TypeScript 7 has no JavaScript compiler API): nothing is imported or run.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";

import { parseSync } from "@swc/core";

import { changedSince, listFiles, replacePrSection, workflowFiles } from "./workflow-files.ts";

const START = "<!-- workflow-contracts:start -->";
const END = "<!-- workflow-contracts:end -->";

const { values: args } = parseArgs({ options: { base: { type: "string" }, pr: { type: "string" } } });

// --- AST access (swc nodes are plain objects with a `type`) ---------------------------------

type AstNode = { readonly type: string; readonly [key: string]: unknown };
const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;
const isNode = (value: unknown): value is AstNode => isObject(value) && typeof value["type"] === "string";
const child = (node: AstNode, key: string): AstNode | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};
const list = (node: AstNode, key: string): unknown[] => {
  const value = node[key];
  return Array.isArray(value) ? (value as unknown[]) : [];
};
const identifier = (value: unknown): string | undefined =>
  isNode(value) && value.type === "Identifier" && typeof value["value"] === "string" ? value["value"] : undefined;

/** Keys that hold types, declarations or positions, never runtime references. */
const NOT_REFERENCES: Readonly<Record<string, true>> = {
  span: true,
  ctxt: true,
  typeAnnotation: true,
  returnType: true,
  typeParameters: true,
  typeArguments: true,
};

const callArguments = (call: AstNode): (AstNode | undefined)[] =>
  list(call, "arguments").map((argument) =>
    isObject(argument) && isNode(argument["expression"]) ? argument["expression"] : undefined,
  );

/** A string literal, or a template literal with no `${…}`. */
function literal(node: AstNode | undefined): string | undefined {
  if (node?.type === "StringLiteral" && typeof node["value"] === "string") return node["value"];
  if (node?.type !== "TemplateLiteral" || list(node, "expressions").length > 0) return undefined;
  const [quasi] = list(node, "quasis");
  return isObject(quasi) && typeof quasi["cooked"] === "string" ? quasi["cooked"] : undefined;
}

/** Properties of an object literal by key; shorthand `{ serdes }` included. */
function properties(node: AstNode | undefined): Map<string, AstNode> {
  const found = new Map<string, AstNode>();
  if (node?.type !== "ObjectExpression") return found;
  for (const property of list(node, "properties")) {
    if (!isNode(property)) continue;
    if (property.type === "Identifier") {
      const name = identifier(property);
      if (name !== undefined) found.set(name, property);
      continue;
    }
    const key = identifier(property["key"]) ?? literal(child(property, "key"));
    const value = child(property, "value");
    if (property.type === "KeyValueProperty" && key !== undefined && value !== undefined) found.set(key, value);
  }
  return found;
}

type FunctionNode = AstNode & { readonly type: "ArrowFunctionExpression" | "FunctionExpression" };
const isFunction = (node: AstNode | undefined): node is FunctionNode =>
  node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";

/** Name of a function's `index`-th parameter (arrow params are patterns, function params wrap them). */
function parameterName(fn: AstNode, index: number): string | undefined {
  const param = list(fn, "params")[index];
  return identifier(isNode(param) && param.type === "Parameter" ? param["pat"] : param);
}

/** Identifiers a pattern declares: `a`, `{ a, b: c }`, `[a, b]`. */
function declaredNames(pattern: unknown, into: Set<string>): void {
  const name = identifier(pattern);
  if (name !== undefined) {
    into.add(name);
    return;
  }
  if (!isNode(pattern)) return;
  for (const element of [...list(pattern, "elements"), ...list(pattern, "properties")]) {
    if (!isNode(element)) continue;
    if (element.type === "AssignmentPatternProperty") declaredNames(element["key"], into);
    else if (element.type === "KeyValuePatternProperty") declaredNames(element["value"], into);
    else if (element.type === "RestElement") declaredNames(element["argument"], into);
    else declaredNames(element, into);
  }
}

/**
 * Runtime references below `value`: `input.noteId` is recorded as root `input`, field `noteId`;
 * a bare `fields` as root `fields` with no field. Declarations and types are not references.
 */
type References = Map<string, Set<string>>;
function collectReferences(value: unknown, into: References, skip?: (node: AstNode) => boolean): void {
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) collectReferences(item, into, skip);
    return;
  }
  if (!isObject(value)) return;
  if (isNode(value)) {
    if (skip?.(value) === true) return;
    switch (value.type) {
      case "Identifier": {
        const name = identifier(value);
        if (name !== undefined && !into.has(name)) into.set(name, new Set());
        return;
      }
      case "MemberExpression": {
        const root = identifier(value["object"]);
        const property = child(value, "property");
        const field = identifier(property);
        if (root !== undefined && field !== undefined) {
          const fields = into.get(root) ?? new Set<string>();
          fields.add(field);
          into.set(root, fields);
          return;
        }
        collectReferences(value["object"], into, skip);
        if (property?.type === "Computed") collectReferences(property, into, skip);
        return;
      }
      case "KeyValueProperty":
        collectReferences(value["value"], into, skip);
        return;
      case "VariableDeclarator":
        collectReferences(value["init"], into, skip);
        return;
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        collectReferences(value["body"], into, skip);
        return;
      default:
        break;
    }
  }
  for (const [key, item] of Object.entries(value))
    if (NOT_REFERENCES[key] !== true) collectReferences(item, into, skip);
}

// --- Workflow analysis ------------------------------------------------------------------------

/**
 * Durable operations and where their arguments sit: `config` is the config argument's index;
 * `inStep` arguments run like a step (no durable operations inside, anything goes);
 * `childContext` arguments are functions whose first parameter is a child durable context.
 */
type OperationSpec = {
  readonly config?: number;
  readonly inStep?: readonly number[];
  readonly childContext?: readonly number[];
};
const OPERATIONS: Readonly<Record<string, OperationSpec>> = {
  step: { config: 2, inStep: [1] },
  wait: {},
  waitForCallback: { config: 2, inStep: [1] },
  createCallback: { config: 1 },
  waitForCondition: { config: 2, inStep: [1] },
  map: { config: 3, childContext: [2] },
  parallel: { config: 2, childContext: [1] },
  runInChildContext: { config: 2, childContext: [1] },
  invoke: {},
};

const PROMISE_COMBINATORS: Readonly<Record<string, true>> = { all: true, allSettled: true, race: true, any: true };

type Operation = {
  readonly kind: string;
  readonly name: string | undefined;
  readonly line: number;
  readonly parent: string | undefined;
  readonly reads: References;
  readonly policy: ReadonlyMap<string, string> | undefined;
  readonly maxConcurrency: string | undefined;
  binding: readonly string[];
};

type Workflow = {
  readonly path: string;
  readonly name: string;
  readonly operations: readonly Operation[];
  /** Handler variables computed from other handler variables (`fields` from `input`). */
  readonly derived: ReadonlyMap<string, References>;
  /** Handler variables the handler itself reads outside durable operations (branches, returns, logs). */
  readonly handlerReads: ReadonlySet<string>;
  readonly violations: readonly string[];
};

type Scope = { readonly contexts: ReadonlySet<string>; readonly inStep: boolean; readonly parent: string | undefined };

const label = (operation: Pick<Operation, "kind" | "name">): string => `${operation.kind} \`${operation.name ?? "?"}\``;

function analyze(path: string, source: string, testSources: string): Workflow {
  const workflow = basename(path, ".ts");
  const bytes = Buffer.from(source);
  const lineAt = (node: AstNode): number => {
    const span = node["span"];
    const start = isObject(span) && typeof span["start"] === "number" ? span["start"] : 1;
    // swc positions are 1-based byte offsets.
    return bytes
      .subarray(0, start - 1)
      .toString("utf8")
      .split("\n").length;
  };
  const violations: string[] = [];
  const fail = (node: AstNode, message: string) => violations.push(`${path}:${lineAt(node)}  ${message}`);

  const module = parseSync(source, { syntax: "typescript", target: "es2024" }) as unknown;
  if (!isNode(module)) throw new Error(`${path}: swc returned no module`);

  // Find `withDurableExecution(<inline handler>, …)`.
  let handler: AstNode | undefined;
  let wrapper: AstNode | undefined;
  const findHandler = (value: unknown): void => {
    if (handler !== undefined) return;
    if (Array.isArray(value)) {
      for (const item of value as unknown[]) findHandler(item);
      return;
    }
    if (!isObject(value)) return;
    if (isNode(value) && value.type === "CallExpression" && identifier(value["callee"]) === "withDurableExecution") {
      wrapper = value;
      const [first] = callArguments(value);
      if (isFunction(first)) handler = first;
      return;
    }
    for (const [key, item] of Object.entries(value)) if (NOT_REFERENCES[key] !== true) findHandler(item);
  };
  findHandler(module);
  if (handler === undefined) {
    if (wrapper !== undefined) fail(wrapper, "withDurableExecution needs the handler as an inline function");
    else violations.push(`${path}:1  no withDurableExecution( call found`);
    return { path, name: workflow, operations: [], derived: new Map(), handlerReads: new Set(), violations };
  }
  const body = handler["body"];
  const contextName = parameterName(handler, 1);

  // Names declared in the handler (outside nested functions): the only data the card tracks.
  const scope = new Set<string>();
  const eventName = parameterName(handler, 0);
  if (eventName !== undefined) scope.add(eventName);
  const collectDeclarations = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value as unknown[]) collectDeclarations(item);
      return;
    }
    if (!isObject(value)) return;
    if (isNode(value) && isFunction(value)) return;
    if (isNode(value) && value.type === "VariableDeclarator") declaredNames(value["id"], scope);
    for (const [key, item] of Object.entries(value)) if (NOT_REFERENCES[key] !== true) collectDeclarations(item);
  };
  collectDeclarations(body);

  const operations: Operation[] = [];
  const byCall = new Map<AstNode, Operation>();
  const derived = new Map<string, References>();

  const inScope = (references: References): References => new Map([...references].filter(([root]) => scope.has(root)));

  const operationKind = (call: AstNode, current: Scope): string | undefined => {
    const callee = child(call, "callee");
    if (callee?.type !== "MemberExpression") return undefined;
    const object = identifier(callee["object"]);
    const property = identifier(callee["property"]);
    if (object === undefined || property === undefined || !current.contexts.has(object)) return undefined;
    return property in OPERATIONS ? property : undefined;
  };

  /** First-parameter names of the functions in a child-context argument (a function, or parallel's branch list). */
  const childContexts = (argument: AstNode | undefined): string[] => {
    const functions: AstNode[] = [];
    if (isFunction(argument)) functions.push(argument);
    else if (argument?.type === "ArrayExpression") {
      for (const element of list(argument, "elements")) {
        const expression = isObject(element) && isNode(element["expression"]) ? element["expression"] : undefined;
        const fn = isFunction(expression) ? expression : properties(expression).get("func");
        if (isFunction(fn)) functions.push(fn);
      }
    }
    return functions.map((fn) => parameterName(fn, 0)).filter((name) => name !== undefined);
  };

  const visitOperation = (call: AstNode, kind: string, current: Scope): void => {
    const spec = OPERATIONS[kind] ?? {};
    const argumentsList = callArguments(call);
    const name = literal(argumentsList[0]);
    const config = spec.config === undefined ? undefined : argumentsList[spec.config];
    const operation: Operation = {
      kind,
      name,
      line: lineAt(call),
      parent: current.parent,
      reads: (() => {
        // Context parameters are not in `scope`, so this also drops `context.*` and child contexts.
        const references: References = new Map();
        collectReferences(argumentsList.slice(1), references);
        return inScope(references);
      })(),
      policy: undefined,
      maxConcurrency: undefined,
      binding: [],
    };
    if (name === undefined) fail(call, `${kind}: the name (first argument) must be a string literal`);

    let policy: Map<string, string> | undefined;
    let maxConcurrency: string | undefined;
    if (kind === "step") {
      if (config?.type !== "CallExpression" || identifier(config["callee"]) !== "stepPolicy") {
        fail(call, `${label(operation)}: pass stepPolicy({ … }) as the third argument`);
      } else {
        policy = new Map();
        for (const [key, value] of properties(callArguments(config)[0])) {
          const text = literal(value);
          if (text === undefined)
            fail(value, `${label(operation)}: stepPolicy field "${key}" must be a string literal`);
          else policy.set(key, text);
        }
        const guard = policy.get("guard");
        if (policy.get("effect") === "write" && guard !== undefined && guard !== "at-most-once" && name !== undefined) {
          const marker = `idempotent: ${workflow}/${name}`;
          if (!testSources.includes(marker)) {
            fail(call, `${label(operation)}: write step without a test named "${marker}" that runs it twice`);
          }
        }
      }
    }
    if (kind === "map" || kind === "parallel") {
      const value = properties(config).get("maxConcurrency");
      if (value === undefined) fail(call, `${label(operation)}: set maxConcurrency (the default is unlimited)`);
      else maxConcurrency = value.type === "NumericLiteral" ? String(value["value"]) : "set";
    }
    if ((kind === "waitForCallback" || kind === "createCallback") && !properties(config).has("serdes")) {
      fail(call, `${label(operation)}: set serdes to parse the callback result (the default is the raw string)`);
    }

    const recorded: Operation = { ...operation, policy, maxConcurrency };
    operations.push(recorded);
    byCall.set(call, recorded);

    for (const [index, argument] of argumentsList.entries()) {
      if (index === 0) continue;
      if (spec.inStep?.includes(index) === true) scan(argument, { ...current, inStep: true });
      else if (spec.childContext?.includes(index) === true) {
        scan(argument, {
          contexts: new Set([...current.contexts, ...childContexts(argument)]),
          inStep: false,
          parent: label(recorded),
        });
      } else scan(argument, current);
    }
  };

  const scan = (value: unknown, current: Scope): void => {
    if (Array.isArray(value)) {
      for (const item of value as unknown[]) scan(item, current);
      return;
    }
    if (!isObject(value)) return;
    if (isNode(value) && value.type === "CallExpression") {
      const kind = operationKind(value, current);
      if (kind !== undefined) {
        visitOperation(value, kind, current);
        return;
      }
      const callee = child(value, "callee");
      if (
        !current.inStep &&
        callee?.type === "MemberExpression" &&
        identifier(callee["object"]) === "Promise" &&
        PROMISE_COMBINATORS[identifier(callee["property"]) ?? ""] === true
      ) {
        fail(value, "Promise combinators outside a step: use context.parallel or context.map");
      }
    }
    if (isNode(value) && value.type === "VariableDeclarator") {
      scan(value["init"], current);
      const declared = child(value, "init");
      const init = declared?.type === "AwaitExpression" ? child(declared, "argument") : declared;
      const operation = init === undefined ? undefined : byCall.get(init);
      const names = new Set<string>();
      declaredNames(value["id"], names);
      if (operation !== undefined) operation.binding = [...names];
      else if (init !== undefined && current.parent === undefined && !current.inStep) {
        const references: References = new Map();
        collectReferences(init, references);
        for (const name of names) derived.set(name, inScope(references));
      }
      return;
    }
    for (const [key, item] of Object.entries(value)) if (NOT_REFERENCES[key] !== true) scan(item, current);
  };

  scan(body, { contexts: new Set(contextName === undefined ? [] : [contextName]), inStep: false, parent: undefined });

  const handlerReferences: References = new Map();
  collectReferences(body, handlerReferences, (node) => node.type === "CallExpression" && byCall.has(node));

  return {
    path,
    name: workflow,
    operations,
    derived,
    handlerReads: new Set([...handlerReferences.keys()].filter((name) => scope.has(name))),
    violations,
  };
}

// --- Rendering --------------------------------------------------------------------------------

const code = (text: string): string => `\`${text}\``;

function effectCell(operation: Operation): string {
  switch (operation.kind) {
    case "step": {
      const effect = operation.policy?.get("effect") ?? "?";
      const once = operation.policy?.get("guard") === "at-most-once";
      return `${effect} · ${once ? "at most once" : "at least once"}`;
    }
    case "wait":
      return "suspends, no compute";
    case "waitForCallback":
    case "createCallback":
      return "waits for an outside callback";
    case "waitForCondition":
      return "polls a condition";
    case "map":
    case "parallel":
      return "runs children concurrently";
    case "runInChildContext":
      return "groups children";
    case "invoke":
      return "calls another function";
    default:
      return "—";
  }
}

function guardCell(operation: Operation, testSources: string, workflow: string): string {
  if (operation.kind !== "step") return "—";
  const effect = operation.policy?.get("effect");
  const guard = operation.policy?.get("guard");
  if (effect === "read") return "not needed (read)";
  if (guard === undefined) return "**missing**";
  if (guard === "at-most-once") return "at most once, no retries";
  const tested = operation.name !== undefined && testSources.includes(`idempotent: ${workflow}/${operation.name}`);
  return `${guard} · ${tested ? "run-twice test ✓" : "**no run-twice test**"}`;
}

function resultCell(operation: Operation, all: readonly Operation[], workflow: Workflow): string {
  if (operation.binding.length === 0) return "—";
  return operation.binding
    .map((name) => {
      const users = all.filter((other) => other !== operation && other.reads.has(name)).map((other) => label(other));
      if (workflow.handlerReads.has(name)) users.push("handler");
      return `${code(name)} → ${users.length === 0 ? "unused" : users.join(", ")}`;
    })
    .join("<br>");
}

const mermaidId = (prefix: string, name: string): string => `${prefix}_${name.replaceAll(/[^A-Za-z0-9_]/g, "_")}`;
const mermaidText = (text: string): string => text.replaceAll('"', "#quot;");

/** Data flow: handler variables (parallelograms) into operations (boxes), results out, and into the handler. */
function dataFlow(workflow: Workflow): string {
  const lines = ["flowchart LR"];
  const variables = new Set<string>();
  const edges: string[] = [];
  const edge = (from: string, to: string, fields: ReadonlySet<string>) =>
    edges.push(
      fields.size === 0 ? `  ${from} --> ${to}` : `  ${from} -->|${mermaidText([...fields].join(", "))}| ${to}`,
    );

  for (const [name, references] of workflow.derived) {
    if (references.size === 0) continue;
    variables.add(name);
    for (const [root, fields] of references) {
      variables.add(root);
      edge(mermaidId("v", root), mermaidId("v", name), fields);
    }
  }
  let handlerUsed = false;
  for (const [index, operation] of workflow.operations.entries()) {
    const id = `op${index + 1}`;
    const detail = operation.kind === "step" ? `<br/>${mermaidText(effectCell(operation))}` : "";
    lines.push(`  ${id}["${mermaidText(`${operation.kind} ${operation.name ?? "?"}`)}${detail}"]`);
    for (const [root, fields] of operation.reads) {
      variables.add(root);
      edge(mermaidId("v", root), id, fields);
    }
    for (const name of operation.binding) {
      variables.add(name);
      edge(id, mermaidId("v", name), new Set());
      if (workflow.handlerReads.has(name)) {
        handlerUsed = true;
        edge(mermaidId("v", name), "handler", new Set());
      }
    }
  }
  for (const name of variables) lines.splice(1, 0, `  ${mermaidId("v", name)}[/"${mermaidText(name)}"/]`);
  if (handlerUsed) lines.push('  handler(("handler: branch / return"))');
  return [...lines, ...edges].join("\n");
}

function card(workflow: Workflow, testSources: string): string {
  const rows = workflow.operations.map((operation, index) => {
    const name = operation.parent === undefined ? label(operation) : `${operation.parent} › ${label(operation)}`;
    const retry =
      operation.kind !== "step"
        ? "—"
        : operation.policy?.get("guard") === "at-most-once"
          ? "none"
          : (operation.policy?.get("retry") ?? "**missing**");
    const reads = [...operation.reads]
      .flatMap(([root, fields]) => (fields.size === 0 ? [root] : [...fields].map((field) => `${root}.${field}`)))
      .map(code)
      .join(", ");
    return [
      String(index + 1),
      name,
      effectCell(operation),
      guardCell(operation, testSources, workflow.name),
      retry,
      operation.maxConcurrency === undefined ? "—" : `max ${operation.maxConcurrency}`,
      reads === "" ? "—" : reads,
      resultCell(operation, workflow.operations, workflow),
    ].join(" | ");
  });
  return [
    `### ${code(workflow.path)}`,
    "",
    "| # | Operation | Effect · semantics | Idempotency | Retry | Concurrency | Reads | Result → used by |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
    "",
    "```mermaid",
    dataFlow(workflow),
    "```",
  ].join("\n");
}

// --- Main -------------------------------------------------------------------------------------

const testSourcesFor = (path: string): string => {
  const app = path.split("/")[1] ?? "";
  return listFiles([`apps/${app}/tests/*.test.ts`, `apps/${app}/tests/**/*.test.ts`])
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
};

const analyzed = workflowFiles().map((path) => {
  const tests = testSourcesFor(path);
  return { workflow: analyze(path, readFileSync(path, "utf8"), tests), tests };
});

let selected = analyzed;
if (args.base !== undefined) {
  const { changed } = changedSince(args.base);
  selected = analyzed.filter(({ workflow }) => changed.has(workflow.path));
}

const markdown =
  selected.length === 0
    ? ""
    : [
        START,
        "## Workflow contracts",
        "",
        "_Generated from source by `vp run workflows:contract`. Step results are checkpointed as JSON (1 MB max) and replayed on resume, not re-run; `stepPolicy` types reject results that JSON would change. A step can still run twice (lost checkpoint, retry), and two executions can run it at once: every write step names its guard and has a test that runs it twice._",
        "",
        selected.map(({ workflow, tests }) => card(workflow, tests)).join("\n\n"),
        END,
      ].join("\n");

if (args.pr === undefined) {
  process.stdout.write(markdown === "" ? "No workflow contracts to show.\n" : `${markdown}\n`);
} else {
  replacePrSection(args.pr, START, END, markdown);
  process.stdout.write(`PR #${args.pr}: ${selected.length} workflow contract(s) in the body.\n`);
}

const violations = analyzed.flatMap(({ workflow }) => workflow.violations);
if (violations.length > 0) {
  process.stderr.write(`\nWorkflow contract violations:\n${violations.map((line) => `  ${line}`).join("\n")}\n`);
  if (args.pr === undefined) process.exitCode = 1;
}
