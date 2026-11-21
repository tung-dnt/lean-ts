# lean-ts

A strict TypeScript starter for serverless products on AWS: one pnpm-workspace monorepo with HTTP and SQS Lambdas, PostgreSQL through Drizzle v1, a React + Vite browser app, and one toolchain (Vite+). Why it looks like this: [ADR 0001](docs/adr/0001-typescript-single-language.md).

## Start

Needs Node 24 (`.node-version`), pnpm 12 (pinned in `package.json` `devEngines`) and Docker for the tests.

```sh
pnpm install          # also installs the pre-commit hook (vp config)
vp run ready          # every gate: check, types, boundaries, db:check, tests, builds
```

| Command                            | Does                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `vp run check`                     | Format check, Oxlint, type-aware lint and type errors through tsgolint |
| `vp run check:fix`                 | Same, fixing what it can                                               |
| `vp run types`                     | `tsc` in every package                                                 |
| `vp run boundaries`                | Workspace boundary rules (`tooling/dependency-cruiser.cjs`)            |
| `vp run db:check`                  | `drizzle-kit check` on the migrations                                  |
| `vp run -r test`                   | Every package's tests, against real PostgreSQL                         |
| `vp run -r build`                  | Lambda bundles and the web build                                       |
| `vp run --filter @lean-ts/web dev` | Web dev server (proxies `/notes` to `localhost:3000`)                  |

`vp run` caches tasks by their input files. Environment variables are not part of the key: after changing one a task reads, add `--no-cache`.

## Layout

```
apps/api            HTTP Lambda (API Gateway HTTP API, payload v2)
apps/worker         SQS Lambda: archives notes, idempotently
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

## Type-aware lint backend

Vite+ 1.7 defaults to tsrs, a prerelease that tracks TypeScript 7.1 beta. This template uses tsgolint on TypeScript 7.0.x instead, by setting `OXLINT_TSGOLINT_PATH` before `vp` starts: in the `check` tasks, the pre-commit hook and CI. So run checks through `vp run check`, not bare `vp check`. Switch back when tsrs ships a stable release (ADR 0001, Triggers).
