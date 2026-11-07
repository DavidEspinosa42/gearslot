import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { categories, labSettings, resources } from "./schema";

/** Dummy reference lab used by `pnpm db:seed`, the scenario script and the docs. */
export const SEED_CATEGORIES = [
  { id: "camera", name: "Cameras", maxActivePerUser: 3 },
  { id: "lens", name: "Lenses", maxActivePerUser: 2 },
  { id: "audio", name: "Audio recorders", maxActivePerUser: 3 },
  { id: "printer", name: "3D printers", maxActivePerUser: 1 },
] as const;

export const SEED_RESOURCES = [
  ...[1, 2, 3].map((n) => ({
    name: `Camera #${n}`,
    categoryId: "camera",
    model: "Sony A7 IV",
    locationLabel: "Cage A, shelf 1",
    bufferMinutes: 0,
  })),
  ...[1, 2].map((n) => ({
    name: `Lens 24-70 #${n}`,
    categoryId: "lens",
    model: "Sony FE 24-70mm f/2.8 GM II",
    locationLabel: "Cage A, shelf 2",
    bufferMinutes: 0,
  })),
  ...[1, 2].map((n) => ({
    name: `Recorder #${n}`,
    categoryId: "audio",
    model: "Zoom H6",
    locationLabel: "Cage B",
    bufferMinutes: 0,
  })),
  {
    name: "Prusa MK4",
    categoryId: "printer",
    model: "Prusa MK4",
    locationLabel: "Print room",
    // Cooldown and cleanup after every job.
    bufferMinutes: 30,
  },
] as const;

/** Inserts the dummy lab. Safe to run repeatedly: existing rows are left as they are. */
export async function seedLab(db: Database): Promise<void> {
  await db.insert(labSettings).values({ id: true }).onConflictDoNothing();
  await db
    .insert(categories)
    .values([...SEED_CATEGORIES])
    .onConflictDoNothing();
  await db
    .insert(resources)
    .values([...SEED_RESOURCES])
    .onConflictDoNothing({ target: resources.name });
}

/** Resource id by name, or undefined. */
export async function findResourceId(db: Database, name: string): Promise<string | undefined> {
  const result = await db.execute<{ id: string }>(
    sql`SELECT id FROM resources WHERE name = ${name}`,
  );
  return result.rows[0]?.id;
}
