import { connectFromEnv, type Database, type DatabaseHandle } from "./client";

const holder = globalThis as typeof globalThis & { __loanLoopDb?: DatabaseHandle };

/** One pooled connection set per server process, kept across hot reloads in development. */
export function getDb(): Database {
  holder.__loanLoopDb ??= connectFromEnv();
  return holder.__loanLoopDb.db;
}
