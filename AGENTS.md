# Agent guide

A lean-ts workspace: TypeScript only, one pnpm-workspace monorepo, AWS Lambda apps, PostgreSQL through Drizzle v1, a React + Vite browser app, and the Vite+ toolchain (`vp`). This file is always loaded, so it stays short. Read the rest only when the change needs it (the table below).

## Always

- TypeScript only. A second language needs a measured trigger and its own ADR ([ADR 0001](docs/adr/0001-typescript-single-language.md)).
- Put code where it belongs: wiring in `apps/*`, pure rules in `packages/domain-*`, every query in `packages/db`, Lambda/config/logging plumbing in `packages/platform`. Before writing new logic, read the package that should own it and reuse what is there.
- Packages export TypeScript source (`exports` → `./src/index.ts`); there is no build step between them. Import another package by name, never by relative path or deep path.
- Validate every input at the boundary with zod (HTTP body and query, queue message, env, API response in the browser). Inside, trust the types.
- Errors the caller must handle are values (`Result` in `domain-*`); unexpected errors throw and are caught once, by `httpLambda` (500) or `sqsLambda` (batch item failure). No empty `catch`, no swallowed promise.
- Every queue handler is idempotent: claim the message ID (`claimMessage`) in the same transaction as the change.
- Tests run the real code against real PostgreSQL with the real migrations (`@lean-ts/db/testing`). No mocks of the database, no interface that exists only so a test can fake it.
- A task is done when `vp run ready` is green.

## Floor

- Run checks through `vp run check` and `vp run ready`, never bare `vp check` or `vp lint`: those fall back to the bundled tsrs prerelease instead of tsgolint.
- No skipped or deleted tests, and no assertions removed from tests that stay, without a reason in the commit message.
- No unimplemented stubs: `throw new Error("TODO")`, `// TODO: implement`, functions that return a placeholder where logic belongs.
- No new suppressions (`// oxlint-disable…`, `// @ts-ignore`, `// @ts-expect-error`, `as any`, `as unknown as`) without a comment giving the reason; a new one also needs a row in [CONSTRAINTS.md](CONSTRAINTS.md) Exceptions.
- No secrets in source and no patient data in code, fixtures or logs. Log identifiers, never bodies.
- Only `packages/db` imports `drizzle-orm`, `drizzle-kit` or a database driver. `apps/web` imports only `packages/domain-*`. `tooling/dependency-cruiser.cjs` enforces both.
- Neither this Floor nor [CONSTRAINTS.md](CONSTRAINTS.md) is weakened in the same PR as the change that was failing.

## Read before you

| Change                                             | Read                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| add an app or a package, or an import between them | [README](README.md) (Layout) and `tooling/dependency-cruiser.cjs`                                                                |
| change the schema or write a query                 | `packages/db/src/schema.ts`, then [README](README.md) (Database)                                                                 |
| add a Lambda handler or change how one is bundled  | `packages/platform/src/http.ts` or `sqs.ts`, `tooling/lambda-pack.ts`                                                            |
| change a lint rule, a tsconfig flag or a check     | `tooling/lint.ts`, `vite.config.ts`, [CONSTRAINTS.md](CONSTRAINTS.md)                                                            |
| upgrade Drizzle, TypeScript, Vite+ or tsgolint     | [ADR 0001](docs/adr/0001-typescript-single-language.md) (decision 6, Triggers) and the catalog comments in `pnpm-workspace.yaml` |
| want to skip, suppress or loosen a check           | [CONSTRAINTS.md](CONSTRAINTS.md)                                                                                                 |
