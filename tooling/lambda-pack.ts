import type { UserConfig } from "vite-plus";

type PackConfig = NonNullable<UserConfig["pack"]>;

/**
 * Shared `vp pack` settings for Lambda apps: one ESM file per entry with every
 * dependency (workspace packages included) inlined, so the deploy artifact needs no
 * node_modules. `onlyImport: []` makes the build fail if anything would still be
 * imported at runtime, apart from Node built-ins and `pg-native` (pg loads it only on
 * request; we never do).
 */
export function lambdaPack(entry: Record<string, string>): PackConfig {
  return {
    entry,
    platform: "node",
    target: "node24",
    format: "esm",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    dts: false,
    deps: {
      alwaysBundle: [/.*/],
      neverBundle: ["pg-native"],
      onlyImport: ["pg-native"],
    },
  };
}
