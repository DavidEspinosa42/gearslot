/**
 * Replays the reference scenario from docs/domain.md against the configured database:
 * 40 students book "Camera #2, Friday 14:00-18:00" at the same instant. Dummy users only.
 * Needs a database that accepts many connections (real PostgreSQL); the PGlite dev server
 * serialises them, which still gives the right answer but not a real race.
 */
import { isDeepStrictEqual } from "node:util";
import { inArray } from "drizzle-orm";
import { connect } from "../src/lib/db/client";
import { labSettings, reservations } from "../src/lib/db/schema";
import { findResourceId, seedLab } from "../src/lib/db/seed";
import { createReservation } from "../src/lib/reservations/service";
import { nextFriday } from "./lib/friday";

const STUDENTS = 40;
const connectionString = process.env["DATABASE_URL"];
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL is not set (see .env.example)");
}
const handle = connect({
  connectionString,
  poolMax: Number(process.env["SCENARIO_POOL"] ?? STUDENTS + 2),
});

const user = (n: number): string => `user-${String(n).padStart(3, "0")}`;

try {
  const { db } = handle;
  await seedLab(db);
  const [settings] = await db.select().from(labSettings);
  const timezone = settings?.timezone ?? "America/Argentina/Buenos_Aires";

  const cameraId = await findResourceId(db, "Camera #2");
  if (cameraId === undefined) throw new Error("Camera #2 is missing; run pnpm db:seed");

  // The next local Friday: 14:00-18:00 is the contested block, 18:00-20:00 touches it.
  const { key: friday, at } = nextFriday(timezone);

  // Reruns stay repeatable: earlier scenario bookings are cancelled (a status change, never a delete).
  const people = Array.from({ length: STUDENTS + 1 }, (_, i) => user(i + 1));
  await db
    .update(reservations)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(inArray(reservations.userId, people));

  console.log(`Camera #2, ${friday} 14:00-18:00 (${timezone})`);
  console.log(`${STUDENTS} students book at the same instant...`);

  const keys = Array.from({ length: STUDENTS }, () => crypto.randomUUID());
  const started = performance.now();
  const results = await Promise.all(
    keys.map((key, i) =>
      createReservation(db, {
        actor: { userId: user(i + 1), displayName: `Student ${i + 1}` },
        idempotencyKey: key,
        resourceId: cameraId,
        startsAt: at(14),
        endsAt: at(18),
        now: new Date(),
      }),
    ),
  );
  const elapsed = Math.round(performance.now() - started);

  const winners = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  const other = results.filter((r) => r.status !== 201 && r.status !== 409);
  console.log(
    `  ${winners.length} confirmed, ${conflicts.length} conflicts, ${other.length} other (${elapsed} ms)`,
  );

  const hint = conflicts[0]?.body["suggestions"] as
    | { identicalUnits: { name: string }[]; nextSlots: { startsAt: string }[] }
    | undefined;
  if (hint !== undefined) {
    console.log(`  a loser is told to try ${hint.identicalUnits.map((u) => u.name).join(" or ")}`);
    console.log(`  or Camera #2 at ${hint.nextSlots.map((s) => s.startsAt).join(", ")}`);
  }

  const touching = await createReservation(db, {
    actor: { userId: user(STUDENTS + 1), displayName: `Student ${STUDENTS + 1}` },
    idempotencyKey: crypto.randomUUID(),
    resourceId: cameraId,
    startsAt: at(18),
    endsAt: at(20),
    now: new Date(),
  });
  console.log(
    `18:00-20:00 touching the winner: ${touching.status === 201 ? "confirmed" : "FAILED"}`,
  );

  const winnerIndex = results.findIndex((r) => r.status === 201);
  const retry =
    winnerIndex < 0
      ? undefined
      : await createReservation(db, {
          actor: { userId: user(winnerIndex + 1), displayName: `Student ${winnerIndex + 1}` },
          idempotencyKey: keys[winnerIndex] ?? "",
          resourceId: cameraId,
          startsAt: at(14),
          endsAt: at(18),
          now: new Date(),
        });
  const sameBooking =
    retry?.replayed === true && isDeepStrictEqual(retry.body, results[winnerIndex]?.body);
  console.log(
    `winner retries with the same key: ${sameBooking ? "same booking returned" : "FAILED"}`,
  );

  const ok =
    winners.length === 1 &&
    conflicts.length === STUDENTS - 1 &&
    other.length === 0 &&
    touching.status === 201 &&
    sameBooking;
  console.log(
    ok ? "PASS: one winner, no 5xx, touching booking accepted, retry idempotent" : "FAIL",
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await handle.close();
}
