import { defineConfig } from "drizzle-kit";

// `generate` and `check` work offline; only `migrate` needs DATABASE_URL.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgres://localhost:5432/lean_ts",
  },
});
