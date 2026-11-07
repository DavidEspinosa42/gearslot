import { connectFromEnv } from "../src/lib/db/client";
import { seedLab } from "../src/lib/db/seed";
import { listResources } from "../src/lib/reservations/service";

const handle = connectFromEnv();
try {
  await seedLab(handle.db);
  const items = await listResources(handle.db);
  console.log(`seeded ${items.length} items:`);
  for (const item of items) {
    console.log(`  ${item.name} (${item.categoryName}, buffer ${item.bufferMinutes} min)`);
  }
} finally {
  await handle.close();
}
