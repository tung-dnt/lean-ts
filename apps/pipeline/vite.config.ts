import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

import { lambdaPack } from "../../tooling/lambda-pack.ts";

export default defineConfig({
  pack: lambdaPack({ handler: "src/handler.ts" }),
  test: {
    globalSetup: [fileURLToPath(import.meta.resolve("@lean-ts/db/testing"))],
    fileParallelism: false,
    hookTimeout: 120_000,
  },
});
