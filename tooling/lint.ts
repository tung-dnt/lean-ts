import type { UserConfig } from "vite-plus";

type LintConfig = NonNullable<UserConfig["lint"]>;

const typeAwareErrors: NonNullable<LintConfig["rules"]> = {
  "typescript/await-thenable": "error",
  "typescript/no-floating-promises": "error",
  "typescript/no-misused-promises": "error",
  "typescript/no-explicit-any": "error",
  "typescript/no-unsafe-argument": "error",
  "typescript/no-unsafe-assignment": "error",
  "typescript/no-unsafe-call": "error",
  "typescript/no-unsafe-member-access": "error",
  "typescript/no-unsafe-return": "error",
  "typescript/no-unnecessary-condition": "error",
  "typescript/restrict-template-expressions": "error",
  "typescript/strict-boolean-expressions": "error",
  "typescript/switch-exhaustiveness-check": "error",
  "typescript/only-throw-error": "error",
  "typescript/prefer-promise-reject-errors": "error",
  "typescript/return-await": ["error", "always"],
  "typescript/consistent-type-imports": "error",
  "typescript/no-non-null-assertion": "error",
  "typescript/ban-ts-comment": "error",
};

export const lintConfig: LintConfig = {
  plugins: ["typescript", "unicorn", "oxc", "import", "promise"],
  jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "error",
  },
  options: {
    typeAware: true,
    typeCheck: true,
    reportUnusedDisableDirectives: "error",
  },
  ignorePatterns: ["**/dist/**", "packages/db/migrations/**"],
  rules: {
    ...typeAwareErrors,
    "vite-plus/prefer-vite-plus-imports": "error",
    "no-console": "error",
    eqeqeq: "error",
    "import/no-cycle": "error",
  },
  overrides: [
    {
      files: ["apps/web/**"],
      plugins: ["react", "jsx-a11y"],
      rules: {
        // React 17+ JSX transform: no `React` import needed.
        "react/react-in-jsx-scope": "off",
        "react/rules-of-hooks": "error",
        "react/exhaustive-deps": "error",
      },
    },
    {
      // Pure and browser code never reads the environment; config is loaded in server apps
      // (`loadConfig`) and passed in. Import boundaries live in tooling/dependency-cruiser.cjs.
      files: ["packages/domain-*/**", "apps/web/src/**"],
      plugins: ["node"],
      rules: { "node/no-process-env": "error" },
    },
    {
      // CDK constructs register themselves in their scope when constructed: `new Topic(this, …)`
      // is the idiom, not a side-effect smell. CONSTRAINTS.md E2.
      files: ["infra/**"],
      rules: { "eslint/no-new": "off" },
    },
    {
      files: ["**/tests/**", "**/*.test.ts", "**/*.test.tsx"],
      plugins: ["vitest"],
      rules: {
        "vitest/no-disabled-tests": "error",
        "vitest/no-focused-tests": "error",
        // CDK's Template.has*/resource*CountIs throw on mismatch: they are assertions.
        "vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "template.has*", "template.resource*"] }],
      },
    },
  ],
};
