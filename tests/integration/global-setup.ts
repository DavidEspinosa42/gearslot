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

/** Vitest's own formatting of errors thrown from a global setup can crash, so print the message first. */
function fail(message: string): never {
  process.stderr.write(`\n${message}\n\n`);
  throw new Error(message);
}

/** The tests truncate every table, so only a database whose name ends in `_test` is accepted. */
function assertThrowawayDatabase(url: string): void {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.slice(1));
  } catch {
    fail("DATABASE_URL_TEST is not a valid PostgreSQL connection URL.");
  }
  if (!name.endsWith("_test")) {
    fail(
      `Refusing to run: DATABASE_URL_TEST names the database "${name}". The integration tests ` +
        'truncate every table, so the database name must end in "_test" (for example gearslot_test).',
    );
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
    fail(
      "DATABASE_URL_TEST is not set. Point it at a local PostgreSQL test database " +
        "(see .env.example and the README).",
    );
  }
  assertThrowawayDatabase(url);

  const handle = connect({ connectionString: url, poolMax: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
  } finally {
    await handle.close();
  }
  project.provide("databaseUrl", url);
}
