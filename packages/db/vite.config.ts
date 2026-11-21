import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    globalSetup: ["./src/testing.ts"],
    // One database per run; files share it, so they run one after another.
    fileParallelism: false,
    hookTimeout: 120_000,
  },
});
