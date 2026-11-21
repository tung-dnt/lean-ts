// Workspace boundary rules from the ADR ("Boundary rules"). `vp run boundaries` runs them
// in CI; any violation fails the build. pnpm's strict layout covers npm dependencies a
// package did not declare; these rules cover what declared dependencies may not do.
// Paths are resolved real paths, so a workspace import such as `@lean-ts/db` shows up
// as `packages/db/src/index.ts` and third-party code as `node_modules/.pnpm/.../<pkg>/`.

/** Matches a resolved third-party module path for any of `names`. */
const npm = (...names) => `(^|/)node_modules/(${names.join("|")})/`;

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "app-to-app",
      comment: "Each app is bundled and deployed on its own: share code through packages/*.",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
    {
      name: "package-to-app",
      comment: "No upward dependencies: packages never import apps.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "relative-import-across-packages",
      comment: "Import another package by name (its `exports`), never by relative path into its files.",
      severity: "error",
      from: { path: "^(apps|packages)/([^/]+)/" },
      to: { dependencyTypes: ["local"], path: "^(apps|packages)/", pathNot: "^$1/$2/" },
    },
    {
      name: "db-owns-the-database",
      comment:
        "Only packages/db imports Drizzle or a database driver: one owner for the RC dependency and every query.",
      severity: "error",
      from: { pathNot: "^packages/db/" },
      to: { path: npm("drizzle-orm", "drizzle-kit", "pg", "pg-[^/]+", "postgres", "mysql2", "@testcontainers/[^/]+") },
    },
    {
      name: "domain-stays-pure",
      comment: "Domain packages hold pure logic: zod and other domain packages only. No Node, AWS, framework or DB.",
      severity: "error",
      from: { path: "^packages/domain-[^/]+/" },
      to: { pathNot: ["^packages/domain-", npm("zod"), "^node_modules/vite-plus/"], dependencyTypesNot: ["type-only"] },
    },
    {
      name: "domain-no-node-builtins",
      comment: "Domain packages run in the browser too: no Node built-ins, not even types.",
      severity: "error",
      from: { path: "^packages/domain-[^/]+/src/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "browser-imports-client-safe-only",
      comment:
        "Browser apps may use only client-safe packages (packages/domain-*): no db, platform or secrets in bundles.",
      severity: "error",
      from: { path: "^apps/web/src/" },
      to: { path: "^packages/", pathNot: "^packages/domain-" },
    },
    {
      name: "browser-no-node-builtins",
      comment: "Browser code cannot use Node built-ins.",
      severity: "error",
      from: { path: "^apps/web/src/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "not-to-unresolvable",
      comment: "Every import must resolve; an unresolvable one hides a missing dependency.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // `exclude` drops matching modules from the graph, dependencies included, so never put
    // node_modules here: rules on third-party imports would silently stop matching.
    exclude: { path: "(^|/)dist/" },
    tsConfig: { fileName: "tsconfig.base.json" },
    // TypeScript 7.0 has no compiler API, so dependency-cruiser parses with swc.
    parser: "swc",
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "module", "types", "default"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".d.ts"],
      mainFields: ["module", "main", "types"],
    },
  },
};
