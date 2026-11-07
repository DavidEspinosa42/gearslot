import { connectFromEnv, type Database, type DatabaseHandle } from "./client";

const holder = globalThis as typeof globalThis & { __gearslotDb?: DatabaseHandle };

/** One pooled connection set per server process, kept across hot reloads in development. */
export function getDb(): Database {
  holder.__gearslotDb ??= connectFromEnv();
  return holder.__gearslotDb.db;
}
