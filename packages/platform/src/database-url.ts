import { getSecret } from "@aws-lambda-powertools/parameters/secrets";

/**
 * The PostgreSQL connection string, read once at cold start. Deployed functions get
 * `DATABASE_SECRET_ARN` (infra/) and read the secret (a plain `postgres://…` string) from
 * Secrets Manager through Powertools Parameters, so the URL never sits in function
 * configuration. Local runs and tests set `DATABASE_URL` instead. Never log the result.
 */
export async function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const direct = env["DATABASE_URL"];
  if (direct !== undefined && direct !== "") return direct;
  const secretArn = env["DATABASE_SECRET_ARN"];
  if (secretArn === undefined || secretArn === "") {
    throw new Error("Invalid configuration: set DATABASE_URL (local) or DATABASE_SECRET_ARN (deployed)");
  }
  const url = await getSecret(secretArn);
  if (typeof url !== "string" || !url.startsWith("postgres")) {
    throw new Error("Invalid configuration: the DATABASE_SECRET_ARN secret must be a postgres:// connection string");
  }
  return url;
}
