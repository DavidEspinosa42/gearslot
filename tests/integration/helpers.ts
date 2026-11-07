import { sql } from "drizzle-orm";
import { inject } from "vitest";
import { connect, type DatabaseHandle } from "../../src/lib/db/client";
import { categories, resources, users } from "../../src/lib/db/schema";

export function connectTestDb(poolMax = 10): DatabaseHandle {
  return connect({ connectionString: inject("databaseUrl"), poolMax });
}

/** Empties every table except the single settings row, which is reset to defaults. */
export async function resetDatabase(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(
    sql`TRUNCATE reservations, idempotency_records, resources, categories, users RESTART IDENTITY CASCADE`,
  );
  await handle.db.execute(
    sql`INSERT INTO lab_settings (id) VALUES (true) ON CONFLICT (id) DO UPDATE SET
      timezone = DEFAULT, slot_minutes = DEFAULT, min_minutes = DEFAULT,
      max_minutes = DEFAULT, horizon_days = DEFAULT, retention_months = DEFAULT`,
  );
}

export interface LabFixture {
  readonly cameras: readonly { id: string; name: string }[];
  readonly printer: { id: string; name: string };
}

/** Three identical cameras and one printer with a 30 minute buffer, as in the reference scenario. */
export async function seedLab(handle: DatabaseHandle): Promise<LabFixture> {
  const { db } = handle;
  await db.insert(categories).values([
    { id: "camera", name: "Cameras", maxActivePerUser: 3 },
    { id: "printer", name: "3D printers", maxActivePerUser: 1 },
  ]);
  const cameras = await db
    .insert(resources)
    .values(
      [1, 2, 3].map((n) => ({
        name: `Camera #${n}`,
        categoryId: "camera",
        model: "Sony A7 IV",
        locationLabel: "Cage A",
      })),
    )
    .returning({ id: resources.id, name: resources.name });
  const [printer] = await db
    .insert(resources)
    .values({
      name: "Prusa MK4",
      categoryId: "printer",
      model: "Prusa MK4",
      locationLabel: "Print room",
      bufferMinutes: 30,
    })
    .returning({ id: resources.id, name: resources.name });
  if (printer === undefined) throw new Error("printer fixture was not created");
  return { cameras: cameras.sort((a, b) => a.name.localeCompare(b.name)), printer };
}

export async function ensureUser(handle: DatabaseHandle, id: string): Promise<void> {
  await handle.db
    .insert(users)
    .values({ id, displayName: `Student ${id}` })
    .onConflictDoNothing();
}
