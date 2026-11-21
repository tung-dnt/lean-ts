import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// No relational query config (`relations`) yet: queries use the SQL-like builder. Add
// `defineRelations` here when a query needs `db.query.*`.
export type Database = NodePgDatabase;

/** A database handle or an open transaction: every query function accepts either. */
export type Executor = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;

export interface DatabaseHandle {
  readonly db: Database;
  close(): Promise<void>;
}

/**
 * One pool per Lambda execution environment, created at cold start. Keep `max` small:
 * each environment handles one request at a time, and RDS Proxy pools behind it.
 */
export function connect(connectionString: string, options: { max?: number } = {}): DatabaseHandle {
  const pool = new Pool({ connectionString, max: options.max ?? 1 });
  return {
    db: drizzle({ client: pool }),
    close: async () => {
      await pool.end();
    },
  };
}

/** Runs `work` in one transaction; it commits when `work` resolves and rolls back when it throws. */
export async function inTransaction<T>(db: Database, work: (tx: Executor) => Promise<T>): Promise<T> {
  return await db.transaction(async (tx) => await work(tx));
}
