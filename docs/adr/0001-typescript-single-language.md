# ADR 0001: TypeScript only, one pnpm-workspace monorepo, Vite+ toolchain

## Status

Accepted for this template (2026-11-21).

## Context

- The target workload is IO-bound: transactions, database reads and writes, calls to cloud and third-party APIs. Latency is dominated by Postgres and the network, not by the language runtime.
- Agents ship most features. What makes them unreliable is fragmentation (several runtimes, package managers, ORMs, ways to do one thing), more than the language.
- A second language (Go, Rust) doubles shared code, supply-chain scanning, agent harnesses and on-call knowledge, and breaks end-to-end types from database to UI.
- A single `package.json` lets any app import any package and forces one version of everything on every app. pnpm workspaces with a strict layout fix both.
- Native tooling is stable enough to standardise on: TypeScript 7 (Go `tsc`), Vite 8 on Rolldown, Vitest 5, Oxlint with type-aware rules, all driven by Vite+.

## Decision

1. **TypeScript is the only application language.** Another language needs its own ADR citing a measured trigger below.
2. **One pnpm-workspace monorepo.** `apps/*` are deployables, `packages/*` shared code exporting `.ts` source (no internal build). One lockfile, one Node LTS, a strict pnpm catalog. Cached tasks via `vp run`, no Turborepo.
3. **Stack:** Node 24 on Lambda, pnpm 12, Drizzle v1 on PostgreSQL, zod at every boundary, one JSON logger.
4. **Heavy work never runs in a request handler:** it goes to its own Lambda or queue worker.
5. **Toolchain:** Vite+ pinned exactly. Type gate is `tsc` 7.0.x plus type-aware Oxlint on **tsgolint** (forced with `OXLINT_TSGOLINT_PATH`), not Vite+'s default tsrs, which is a prerelease targeting TypeScript 7.1 beta.
6. **Drizzle v1 release-candidate guards** until 1.0 is GA: exact pins, upgrades in their own PR; only `packages/db` imports Drizzle; every generated `migration.sql` reviewed; `drizzle-kit check` in CI; tests on real Postgres; migrations as a deploy step, never at cold start; no production personal data on the RC without explicit sign-off.

## Boundary rules

Enforced in CI by pnpm's strict layout plus `tooling/dependency-cruiser.cjs` (swc parser, since TypeScript 7.0 has no compiler API):

| Rule                                                                                       | Why                                                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `apps/*` depend on `packages/*`; never on another app; packages never on apps              | Each app bundles and deploys on its own; no upward edges                      |
| Import packages by name (their `exports`), never by relative or deep path                  | One public surface per package                                                |
| Only `packages/db` imports Drizzle and database drivers                                    | One owner for the RC dependency and every query                               |
| `packages/domain-*` import only zod and other domains; no Node built-ins, no `process.env` | Pure, testable, browser-safe logic                                            |
| Browser apps import only `packages/domain-*`                                               | No DB clients or secrets in browser bundles                                   |
| Per-package `tsconfig` with explicit `types` (browser: `dom`, no `node`)                   | Server code can't type-check against `window`, browser code against `process` |
| Lambda bundles inline every dependency; native modules (`pg-native`) stay external         | One-file deploys                                                              |

## Triggers

| Change                                      | Only when                                                                                                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drop the Drizzle RC guards                  | Drizzle 1.0 is GA (keep exact pins and migration review)                                                                                                                                                   |
| Add Turborepo                               | CI needs a remote cache shared across machines                                                                                                                                                             |
| Switch the type-aware backend to tsrs       | tsrs ships a stable release against the TypeScript version in use, and matches `tsc` on this repo                                                                                                          |
| A second language, for one isolated service | Measured: CPU dominates p99 or cost and offloading doesn't fix it; a static binary must run on-site; a long-running high-concurrency process with measured GC/memory cost; or measured supply-chain burden |

## Consequences

- Good: one toolchain and harness for people and agents; types end to end; pnpm enforces npm-level boundaries; one migration folder per change avoids journal conflicts on parallel branches.
- Accepted: workspace boundaries hold only while CI enforces them; more `package.json` files (the catalog keeps versions aligned); RC upgrades can break code; TypeScript types vanish at runtime (hence zod), and `AbortSignal` is weaker than Go's `context` (hence idempotency and transactions).

## Alternatives rejected

- Go or Rust now: cost outweighs benefit for IO-bound work; kept as triggers.
- Single `package.json`; Turborepo/Nx; Kysely (no schema-to-migration generation); Drizzle 0.45 (shared-journal migrations); Biome (type-aware rules experimental); ESLint + typescript-eslint (slow, needs TS 6 alongside TS 7); tsrs now (prerelease, TS 7.1 beta).
