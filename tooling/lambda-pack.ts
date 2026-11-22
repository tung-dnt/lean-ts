import type { UserConfig } from "vite-plus";

type PackConfig = Extract<NonNullable<UserConfig["pack"]>, { entry?: unknown }>;

/**
 * Shared `vp pack` settings for Lambda apps: one ESM file per entry with every
 * dependency (workspace packages included) inlined, so the deploy artifact needs no
 * node_modules. Two imports stay outside the bundle, and `onlyImport` fails the build on any
 * other: `pg-native` (pg loads it only on request; we never do) and
 * `@aws-sdk/client-secrets-manager`, which the nodejs24.x runtime ships (bundling it added
 * ~1 MB to every function). `codeSplitting: false` inlines dynamic imports too, so each
 * entry stays one file. `copy` ships extra files next to the bundle (the migrator's migrations).
 */
export function lambdaPack(entry: Record<string, string>, options: { copy?: PackConfig["copy"] } = {}): PackConfig {
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
      neverBundle: ["pg-native", "@aws-sdk/client-secrets-manager"],
      onlyImport: ["pg-native", "@aws-sdk/client-secrets-manager"],
    },
    outputOptions: { codeSplitting: false },
    ...(options.copy === undefined ? {} : { copy: options.copy }),
  };
}
