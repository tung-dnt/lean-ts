import type { z } from "zod";

/**
 * Parses environment variables once, at cold start, and fails loudly on anything
 * missing or malformed. Code reads the returned object, never `process.env`.
 */
export function loadConfig<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv = process.env): z.output<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
  }
  return parsed.data;
}
