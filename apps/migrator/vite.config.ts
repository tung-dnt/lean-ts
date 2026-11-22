import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

import { lambdaPack } from "../../tooling/lambda-pack.ts";

export default defineConfig({
  // The migration files ship next to the bundle (dist/migrations).
  pack: lambdaPack({ handler: "src/handler.ts" }, { copy: [{ from: "../../packages/db/migrations", to: "dist" }] }),
  test: {
    globalSetup: [fileURLToPath(import.meta.resolve("@lean-ts/db/testing"))],
    fileParallelism: false,
    hookTimeout: 120_000,
  },
});
