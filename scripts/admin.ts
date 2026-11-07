/** Operator actions in place of an admin UI (v1). Run with `pnpm admin -- <command> ...`. */
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { connectFromEnv } from "../src/lib/db/client";
import { categories, resources } from "../src/lib/db/schema";
import { listResources } from "../src/lib/reservations/service";

const USAGE = `commands:
  list
  add-category --id <slug> --name <text> --cap <n>
  set-cap --id <category> --cap <n>
  add-resource --name <text> --category <slug> --model <text> --location <text> [--buffer <minutes>]
  set-buffer --name <text> --buffer <minutes>
  deactivate --name <text>
  activate --name <text>`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: "string" },
    name: { type: "string" },
    cap: { type: "string" },
    category: { type: "string" },
    model: { type: "string" },
    location: { type: "string" },
    buffer: { type: "string" },
  },
});

function need(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") throw new Error(`missing --${flag}\n${USAGE}`);
  return value;
}

function whole(value: string | undefined, flag: string): number {
  const n = Number(need(value, flag));
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`--${flag} must be a non-negative whole number`);
  return n;
}

const handle = connectFromEnv();
try {
  const { db } = handle;
  switch (positionals[0]) {
    case "list": {
      for (const item of await listResources(db)) {
        console.log(
          `${item.name}\t${item.categoryId}\t${item.model}\tbuffer ${item.bufferMinutes} min`,
        );
      }
      break;
    }
    case "add-category": {
      await db.insert(categories).values({
        id: need(values.id, "id"),
        name: need(values.name, "name"),
        maxActivePerUser: whole(values.cap, "cap"),
      });
      console.log("category added");
      break;
    }
    case "set-cap": {
      await db
        .update(categories)
        .set({ maxActivePerUser: whole(values.cap, "cap") })
        .where(eq(categories.id, need(values.id, "id")));
      console.log("cap updated");
      break;
    }
    case "add-resource": {
      await db.insert(resources).values({
        name: need(values.name, "name"),
        categoryId: need(values.category, "category"),
        model: need(values.model, "model"),
        locationLabel: need(values.location, "location"),
        bufferMinutes: values.buffer === undefined ? 0 : whole(values.buffer, "buffer"),
      });
      console.log("resource added");
      break;
    }
    case "set-buffer": {
      // Applies to new bookings only: existing reservations keep the buffer they were made with.
      await db
        .update(resources)
        .set({ bufferMinutes: whole(values.buffer, "buffer") })
        .where(eq(resources.name, need(values.name, "name")));
      console.log("buffer updated for new bookings");
      break;
    }
    case "deactivate":
    case "activate": {
      await db
        .update(resources)
        .set({ active: positionals[0] === "activate" })
        .where(eq(resources.name, need(values.name, "name")));
      console.log(`${positionals[0]}d`);
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
} finally {
  await handle.close();
}
