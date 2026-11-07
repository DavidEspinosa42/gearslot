import { connectFromEnv } from "../src/lib/db/client";
import { purgeHistory } from "../src/lib/reservations/purge";

const handle = connectFromEnv();
try {
  const report = await purgeHistory(handle.db, new Date());
  console.log(
    `purged ${report.reservations} reservations, ${report.idempotencyRecords} idempotency records, ${report.users} users`,
  );
} finally {
  await handle.close();
}
