import { runMigrations } from "./migrate.ts";

const url = process.env["DATABASE_URL"];
if (url === undefined || url === "") {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(1);
}
await runMigrations(url);
process.stdout.write("migrations applied\n");
