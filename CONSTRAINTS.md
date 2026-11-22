# Constraints

This is the quality bar for people and AI agents. Do not weaken it to make a change pass: tightening is silent, loosening needs the owner's explicit OK in the PR. [AGENTS.md](AGENTS.md) holds the Floor and says what to read for which change.

When you start a project from this template, put your name and the date on the line below, and fill in the Measured and Exceptions tables as the project gets real numbers.

Last reviewed: _(date)_ by _(owner)_.

## Floor (always enforced)

The Floor is in [AGENTS.md](AGENTS.md), so that every agent has it loaded from its first turn. It is part of this bar and is held to the same rule.

## Enforced with numbers

| Dimension          | Rule                                                                                                                                                                               | Checked by                                           | Runs at                                | Blocks |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------- | ------ |
| Format             | oxfmt, print width 120                                                                                                                                                             | `vp run check`                                       | pre-commit (`vp staged`), task end, CI | yes    |
| Lint               | Zero findings: correctness, suspicious and perf categories plus the rules in `tooling/lint.ts`, all errors                                                                         | `vp run check` (Oxlint)                              | pre-commit, task end, CI               | yes    |
| Type-aware lint    | Zero findings, including type errors (`typeCheck`)                                                                                                                                 | `vp run check` (tsgolint, TypeScript 7.0.x)          | pre-commit, task end, CI               | yes    |
| Types              | Zero errors per package, strict flags in `tsconfig.base.json`                                                                                                                      | `vp run types` (`tsc` 7.0.x in every package)        | task end, CI                           | yes    |
| Boundaries         | No violation of the ADR boundary rules                                                                                                                                             | `vp run boundaries` (dependency-cruiser, swc parser) | task end, CI                           | yes    |
| Migrations         | Generated migrations consistent with each other                                                                                                                                    | `vp run db:check` (`drizzle-kit check`)              | task end, CI                           | yes    |
| Workflow graphs    | Every durable workflow (a file under `apps/*/src` calling `withDurableExecution(`) can be drawn from source                                                                        | `vp run workflows:graph` (durable-viz)               | task end, CI; graphs go in the PR body | yes    |
| Workflow contracts | Literal operation names; `stepPolicy` on every step; an `idempotent:` test per write step; `maxConcurrency` on map/parallel; `serdes` on callbacks; no `Promise.all` outside steps | `vp run workflows:contract` (swc)                    | task end, CI; cards go in the PR body  | yes    |
| Tests              | All pass against real PostgreSQL 17                                                                                                                                                | `vp run -r test` (Vitest)                            | task end, CI                           | yes    |
| Build              | Lambda bundles (one ESM file, every dependency inlined) and the web app build                                                                                                      | `vp run -r build`                                    | task end, CI                           | yes    |
| Dependencies       | Every version from the catalog (`catalogMode: strict`); no install scripts unless allowed; no trust downgrade; minimum release age                                                 | pnpm (`pnpm-workspace.yaml`)                         | install, CI                            | yes    |

`vp run ready` runs every row. CI (`.github/workflows/ci.yml`) runs one named step per row, each even when an earlier one failed.

## Measured (ratchets)

| Metric                           | Today                                                                        | Direction         | Why this number                                                               |
| -------------------------------- | ---------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| `apps/api/dist/handler.mjs`      | 809 kB (176 kB gzip), template; Powertools router, logger, parameters        | ≤ +10% per change | Cold start grows with bundle size                                             |
| `apps/worker/dist/handler.mjs`   | 805 kB (173 kB gzip), template; Powertools batch, parser, logger, parameters | ≤ +10% per change | Same                                                                          |
| `apps/migrator/dist/handler.mjs` | 745 kB (161 kB gzip), template                                               | ≤ +10% per change | Same                                                                          |
| `apps/pipeline/dist/handler.mjs` | 2.88 MB, template (bundles `@aws-sdk/client-lambda` for the durable SDK)     | ≤ +10% per change | Same; the next cut is using the runtime's AWS SDK, once its version is pinned |
| `apps/web` JS gzip               | 91 kB, template                                                              | ≤ +10% per change | React + zod dominate; growth should be deliberate                             |

## Exceptions

| ID  | Rule                             | Path                  | Reason                                                                                 | Owner    | Expires                           |
| --- | -------------------------------- | --------------------- | -------------------------------------------------------------------------------------- | -------- | --------------------------------- |
| E1  | `exactOptionalPropertyTypes` off | `infra/tsconfig.json` | aws-cdk-lib's own types fail under it (`Bucket` vs `IBucket.isWebsite`)                | template | when aws-cdk-lib types support it |
| E2  | `eslint/no-new` off              | `infra/**`            | CDK constructs register in their scope when constructed; `new X(this, …)` is the idiom | template | none                              |
