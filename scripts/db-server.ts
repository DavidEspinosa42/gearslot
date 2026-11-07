/**
 * Local development database: PGlite (PostgreSQL compiled to WASM) behind a TCP socket, so the app
 * connects with an ordinary `postgres://` URL. Data persists in `.pglite/`. No Docker needed.
 * Concurrency tests do NOT use this server; see docs/adr/0004.
 */
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const host = process.env["PGLITE_HOST"] ?? "127.0.0.1";
const port = Number(process.env["PGLITE_PORT"] ?? "54320");
const dataDir = process.env["PGLITE_DATA_DIR"] ?? ".pglite";

const db = await PGlite.create(dataDir, { extensions: { btree_gist } });
const server = new PGLiteSocketServer({ db, host, port });
await server.start();
console.log(
  `PGlite listening on postgres://postgres:postgres@${host}:${port}/postgres (data: ${dataDir})`,
);

async function shutdown(): Promise<void> {
  await server.stop();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
