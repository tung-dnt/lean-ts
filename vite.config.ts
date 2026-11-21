import { defineConfig } from "vite-plus";

import { lintConfig } from "./tooling/lint.ts";

// Type-aware lint runs on tsgolint (stable, TypeScript 7.0.x), not Vite+'s bundled tsrs
// (prerelease, TypeScript 7.1 beta). Oxlint picks the backend from OXLINT_TSGOLINT_PATH,
// which must be set before `vp` starts: setting process.env in this file is too late.
// So checks run through `vp run check` / `vp run ready`, the pre-commit hook exports it,
// and CI sets it for the job. Why: AGENTS.md "Checks".
const tsgolint = "OXLINT_TSGOLINT_PATH=node_modules/.bin/tsgolint";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    printWidth: 120,
    ignorePatterns: ["packages/db/migrations/**", "pnpm-lock.yaml"],
  },
  lint: lintConfig,
  run: {
    cache: true,
    tasks: {
      check: {
        command: `${tsgolint} vp check`,
      },
      "check:fix": {
        command: `${tsgolint} vp check --fix`,
        cache: false,
      },
      types: {
        command: "vp run -r typecheck",
      },
      boundaries: {
        command: "depcruise apps packages --config tooling/dependency-cruiser.cjs",
      },
      "db:check": {
        command: "vp run --filter @lean-ts/db db:check",
      },
      // The full gate: what CI runs and what "done" means for a task.
      ready: {
        command:
          "vp run check && vp run types && vp run boundaries && vp run db:check && vp run -r test && vp run -r build",
        cache: false,
      },
    },
  },
});
