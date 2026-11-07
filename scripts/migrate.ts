import { migrate } from "drizzle-orm/node-postgres/migrator";
import { connectFromEnv } from "../src/lib/db/client";

const handle = connectFromEnv();
try {
  await migrate(handle.db, { migrationsFolder: "./drizzle" });
  console.log("migrations applied");
} finally {
  await handle.close();
}
