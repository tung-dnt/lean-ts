# lean-ts

A strict TypeScript starter for serverless products on AWS: one pnpm-workspace monorepo with HTTP and SQS Lambdas, PostgreSQL through Drizzle v1, a React + Vite browser app, and one toolchain (Vite+). Why it looks like this: [ADR 0001](docs/adr/0001-typescript-single-language.md).

## Start

Needs Node 24 (`.node-version`), pnpm 12 (pinned in `package.json` `devEngines`) and Docker for the tests.

```sh
pnpm install          # also installs the pre-commit hook (vp config)
vp run ready          # every gate: check, types, boundaries, db:check, workflow graphs, tests, builds
```

| Command                            | Does                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `vp run check`                     | Format check, Oxlint, type-aware lint and type errors through tsgolint |
| `vp run check:fix`                 | Same, fixing what it can                                               |
| `vp run types`                     | `tsc` in every package                                                 |
| `vp run boundaries`                | Workspace boundary rules (`tooling/dependency-cruiser.cjs`)            |
| `vp run db:check`                  | `drizzle-kit check` on the migrations                                  |
| `vp run workflows:graph`           | Mermaid graph of every durable workflow, from source (durable-viz)     |
| `vp run -r test`                   | Every package's tests, against real PostgreSQL                         |
| `vp run -r build`                  | Lambda bundles and the web build                                       |
| `vp run --filter @lean-ts/web dev` | Web dev server (proxies `/notes` to `localhost:3000`)                  |

`vp run` caches tasks by their input files. Environment variables are not part of the key: after changing one a task reads, add `--no-cache`.

## Layout

```
apps/api            HTTP Lambda (API Gateway HTTP API, payload v2)
apps/worker         SQS Lambda: archives notes, idempotently
apps/pipeline       durable workflows (Lambda durable functions), one function per workflow
apps/web            React + Vite browser app
packages/domain-*   pure rules and zod schemas; client-safe (browser and server)
packages/db         schema, migrations, client, queries: the only importer of Drizzle and pg
packages/platform   server-only plumbing: config, JSON logger, Lambda adapters
tooling/            lint config, boundary rules, shared Lambda bundling config
```

Dependencies point one way: `apps/*` → `packages/*`, never back, never app to app. The browser app may use only `packages/domain-*`. pnpm's strict layout stops a package importing what its `package.json` does not declare; `vp run boundaries` enforces the rest. Every shared version lives in the `pnpm-workspace.yaml` catalog.

To add a domain, copy `packages/domain-note` to `packages/domain-<name>`, rename the package, and keep it free of IO: no Node built-ins, no `process.env`, no AWS SDK, no database.

## Database

- Schema: `packages/db/src/schema.ts`. After changing it, run `vp run --filter @lean-ts/db db:generate` (it runs `drizzle-kit generate`), then read the generated `migration.sql` before committing: Drizzle v1 is a release candidate.
- Queries live in `packages/db/src/*.ts` and take an `Executor` (a database or an open transaction). `inTransaction` commits when the callback resolves and rolls back when it throws.
- Migrations run as a deploy step (`DATABASE_URL=… vp run --filter @lean-ts/db db:migrate`), never at Lambda cold start.
- Tests: each package's Vitest global setup (`@lean-ts/db/testing`) creates a fresh database, migrates it and drops it afterwards. Without `TEST_DATABASE_URL` it starts a `postgres:17-alpine` container; with it (CI) it creates the database on that server, whose role needs `CREATEDB`.

## Lambda bundles

`vp pack` builds `apps/*/dist/handler.mjs`: one ESM file with every dependency, workspace packages included, so the deploy artifact needs no `node_modules`. Handler: `handler.handler`, runtime `nodejs24.x`. Settings: `tooling/lambda-pack.ts`. Each Lambda reads `DATABASE_URL` at cold start.

## Durable workflows

`apps/pipeline` holds workflows built on [Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html): plain TypeScript where `context.step` checkpoints a result and `context.wait` suspends the run without compute charges. `src/archive-note.ts` is the example: check the note, wait out a grace period, archive it.

Rules (the code is replayed from the top after every wait or retry):

- One durable function per workflow; production invokes a published version through an alias (`live`), never `$LATEST`, so runs in flight keep the code they started with.
- Side effects and clock reads only inside `context.step`. Step names are a contract with runs in flight: renaming or reordering one breaks them.
- Steps return IDs and outcomes, never patient data: results are stored in the execution history.
- The caller starts a run with the correlation ID in the execution name (`--durable-execution-name archive-note-<correlationId>`). Lambda then refuses a second run with that name and a different payload, and the ID is in the execution ARN on every span.
- `withDurableExecution` wraps the handler inline in the workflow file, so durable-viz can draw it.

Observability: the durable SDK's OpenTelemetry plugin emits one trace per run (a span named after the workflow, a span per step and wait, an attempt span per try). Spans go to the global provider, which the ADOT / Application Signals Lambda layer registers (`AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument`). Steps put `correlation.id` on their attempt span. `context.logger` goes through `src/durable-log.ts` to the platform JSON logger, so lines carry `correlationId`, `executionArn`, `operationName` and `traceId`, and are not repeated on replay. Per workflow, Lambda's `DurableExecution*` metrics count runs, and grouping spans by `attributes.durable.operation.name` in Logs Insights (`aws/spans`, with CloudWatch Transaction Search on) gives runs, failures and p95 per step.

Tests run the workflow with the SDK's `LocalDurableTestRunner`, which replays it like Lambda, against real PostgreSQL.

## Workflow graphs in pull requests

`vp run workflows:graph` draws every workflow as a Mermaid flowchart from source with [durable-viz](https://github.com/gunnargrosch/durable-viz) (static analysis: nothing runs). It fails when a workflow can't be drawn, which is why it is in `vp run ready`.

On pull requests, the `workflow-graphs` CI job runs `node tooling/workflow-graph.ts --base origin/<target> --pr <number>`: for each workflow file the PR changes, it writes the graph before and after into the PR body, between `<!-- workflow-graphs:start -->` and `<!-- workflow-graphs:end -->`. It keeps the rest of the body, rewrites only that section on each push, and removes it when no workflow changed. It runs on same-repository PRs only (a fork's token can't edit the PR).

What the graph doesn't show: durable-viz draws durable operations and the `if`s and loops around them. A branch with no durable call inside (an early `return`, for example) is not drawn, and helpers imported from another file are not followed. Review the code for those.

## Type-aware lint backend

Vite+ 1.7 defaults to tsrs, a prerelease that tracks TypeScript 7.1 beta. This template uses tsgolint on TypeScript 7.0.x instead, by setting `OXLINT_TSGOLINT_PATH` before `vp` starts: in the `check` tasks, the pre-commit hook and CI. So run checks through `vp run check`, not bare `vp check`. Switch back when tsrs ships a stable release (ADR 0001, Triggers).
