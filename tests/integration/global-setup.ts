import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { TestProject } from "vitest/node";
import { connect } from "../../src/lib/db/client";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** DATABASE_URL_TEST from the environment, else from `.env`. Nothing else in `.env` is loaded. */
function readTestDatabaseUrl(): string | undefined {
  const fromEnv = process.env["DATABASE_URL_TEST"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    return parseEnv(readFileSync(".env", "utf8"))["DATABASE_URL_TEST"];
  } catch {
    return undefined;
  }
}

/**
 * Uses the locally installed PostgreSQL named by DATABASE_URL_TEST (never SQLite, MySQL or PGlite:
 * see docs/adr/0004), then applies the migrations once for the whole run. The tests truncate every
 * table, so the URL must point at a throwaway database.
 */
export async function setup(project: TestProject): Promise<void> {
  const url = readTestDatabaseUrl();
  if (url === undefined || url === "") {
    throw new Error(
      "DATABASE_URL_TEST is not set. Point it at a local PostgreSQL test database " +
        "(see .env.example and the README).",
    );
  }

  const handle = connect({ connectionString: url, poolMax: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
  } finally {
    await handle.close();
  }
  project.provide("databaseUrl", url);
}
