import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { TestProject } from "vitest/node";
import { connect } from "../../src/lib/db/client";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/**
 * Starts a real PostgreSQL (never SQLite, MySQL or PGlite: see docs/adr/0004), or uses
 * DATABASE_URL_TEST when provided, then applies the migrations once for the whole run.
 */
export async function setup(project: TestProject): Promise<void> {
  let url = process.env["DATABASE_URL_TEST"];
  if (url === undefined || url === "") {
    container = await new PostgreSqlContainer("postgres:18-alpine")
      .withDatabase("loanloop_test")
      .withCommand(["postgres", "-c", "max_connections=200"])
      .start();
    url = container.getConnectionUri();
  }

  const handle = connect({ connectionString: url, poolMax: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
  } finally {
    await handle.close();
  }
  project.provide("databaseUrl", url);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
