import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

export interface ConnectOptions {
  readonly connectionString: string;
  /** Maximum pooled connections. Use 1 against the local PGlite socket server. */
  readonly poolMax?: number;
}

export function connect(options: ConnectOptions): DatabaseHandle {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
  });
  // An idle client error must not crash the process; the next query reconnects.
  pool.on("error", () => {});
  const db = drizzle({ client: pool, schema });
  return { db, pool, close: () => pool.end() };
}

/** Reads `DATABASE_URL` and `DATABASE_POOL_MAX` from the environment. */
export function connectFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseHandle {
  const connectionString = env["DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    throw new Error("DATABASE_URL is not set (see .env.example)");
  }
  const poolMax = Number(env["DATABASE_POOL_MAX"] ?? "10");
  return connect({
    connectionString,
    poolMax: Number.isInteger(poolMax) && poolMax > 0 ? poolMax : 10,
  });
}

export { schema };
