import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { reservations } from "../../src/lib/db/schema";
import {
  type Actor,
  createReservation,
  rescheduleReservation,
} from "../../src/lib/reservations/service";
import { connectTestDb, type LabFixture, resetDatabase, seedLab } from "./helpers";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const at = (hourUtc: number, day = 13): Date => new Date(Date.UTC(2026, 10, day, hourUtc));

const handle = connectTestDb(30);
let lab: LabFixture;

const student = (n: number): Actor => ({ userId: `user-${n}`, displayName: `Student ${n}` });
const camera = (n: number): string => {
  const found = lab.cameras[n - 1];
  if (found === undefined) throw new Error("fixture");
  return found.id;
};

async function book(actor: Actor, resourceId: string, start: Date, end: Date): Promise<string> {
  const result = await createReservation(handle.db, {
    actor,
    idempotencyKey: crypto.randomUUID(),
    resourceId,
    startsAt: start,
    endsAt: end,
    now: NOW,
  });
  if (result.status !== 201) throw new Error(`setup booking failed: ${result.status}`);
  return (result.body["reservation"] as { id: string }).id;
}

const move = (actor: Actor, reservationId: string, start: Date, end: Date, key?: string) =>
  rescheduleReservation(handle.db, {
    actor,
    idempotencyKey: key ?? crypto.randomUUID(),
    reservationId,
    startsAt: start,
    endsAt: end,
    now: NOW,
  });

beforeEach(async () => {
  await resetDatabase(handle);
  lab = await seedLab(handle);
});

afterAll(async () => {
  await handle.close();
});

describe("rescheduleReservation", () => {
  it("moves the booking, frees the old slot and takes the new one", async () => {
    const id = await book(student(1), camera(2), at(17), at(21));
    const moved = await move(student(1), id, at(21), at(23));
    expect(moved.status).toBe(200);
    expect(moved.body["reservation"]).toMatchObject({
      startsAt: "2026-11-13T21:00:00.000Z",
      endsAt: "2026-11-13T23:00:00.000Z",
    });
    // The old slot is bookable again.
    await book(student(2), camera(2), at(17), at(21));
  });

  it("answers a clash with 409, suggestions, and leaves the original untouched", async () => {
    const id = await book(student(1), camera(2), at(17), at(21));
    await book(student(2), camera(2), at(21), at(23));
    const clash = await move(student(1), id, at(20), at(22));
    expect(clash).toMatchObject({ status: 409, body: { code: "conflict" } });
    const [row] = await handle.db.select().from(reservations).where(eq(reservations.id, id));
    expect(row?.startsAt).toEqual(at(17));
    expect(row?.status).toBe("active");
  });

  it("allows shrinking or sliding into its own old range", async () => {
    const id = await book(student(1), camera(2), at(17), at(21));
    expect((await move(student(1), id, at(18), at(21))).status).toBe(200);
  });

  it("counts the printer buffer when moving", async () => {
    const id = await book(student(1), lab.printer.id, at(13), at(15));
    await book(student(2), lab.printer.id, at(16), at(17));
    const at30 = (hour: number) => new Date(at(hour).getTime() + 30 * 60_000);
    // 15:00-16:00 plus its 30 min buffer runs to 16:30 and into the 16:00 job.
    const clash = await move(student(1), id, at(15), at(16));
    expect(clash).toMatchObject({ status: 409, body: { code: "conflict" } });
    // 14:30-15:30 plus buffer ends exactly at 16:00, touching the next job, so it fits.
    const fits = await move(student(1), id, at30(14), at30(15));
    expect(fits.status).toBe(200);
    expect(fits.body["reservation"]).toMatchObject({ blockedUntil: "2026-11-13T16:00:00.000Z" });
  });

  it("validates rules, ownership and state", async () => {
    const id = await book(student(1), camera(2), at(17), at(21));
    const offGrid = await move(student(1), id, new Date(at(18).getTime() + 60_000), at(20));
    expect(offGrid).toMatchObject({ status: 422, body: { code: "not_aligned" } });
    expect((await move(student(2), id, at(18), at(20))).status).toBe(404);
  });

  it("replays for the same key and rejects the key with another body", async () => {
    const id = await book(student(1), camera(2), at(17), at(21));
    const key = crypto.randomUUID();
    const first = await move(student(1), id, at(21), at(23), key);
    const retry = await move(student(1), id, at(21), at(23), key);
    expect(retry).toMatchObject({ status: 200, replayed: true });
    expect(retry.body).toEqual(first.body);
    expect((await move(student(1), id, at(18), at(20), key)).status).toBe(422);
  });

  it("keeps reconciling the original create key after a reschedule and a purge of its record", async () => {
    const key = crypto.randomUUID();
    const created = await createReservation(handle.db, {
      actor: student(1),
      idempotencyKey: key,
      resourceId: camera(2),
      startsAt: at(17),
      endsAt: at(21),
      now: NOW,
    });
    const id = (created.body["reservation"] as { id: string }).id;
    await move(student(1), id, at(21), at(23));
    await handle.db.execute(sql`DELETE FROM idempotency_records`);

    const original = await createReservation(handle.db, {
      actor: student(1),
      idempotencyKey: key,
      resourceId: camera(2),
      startsAt: at(17),
      endsAt: at(21),
      now: NOW,
    });
    expect(original.status).toBe(201); // the original request is still recognised
    const different = await createReservation(handle.db, {
      actor: student(1),
      idempotencyKey: key,
      resourceId: camera(2),
      startsAt: at(21),
      endsAt: at(23),
      now: NOW,
    });
    expect(different).toMatchObject({ status: 422, body: { code: "idempotency_mismatch" } });
  });

  it("fingerprints a pre-migration row (empty create_hash) on its first reschedule", async () => {
    const key = crypto.randomUUID();
    const created = await createReservation(handle.db, {
      actor: student(1),
      idempotencyKey: key,
      resourceId: camera(2),
      startsAt: at(17),
      endsAt: at(21),
      now: NOW,
    });
    const id = (created.body["reservation"] as { id: string }).id;
    await handle.db.execute(sql`UPDATE reservations SET create_hash = '' WHERE id = ${id}`);
    await move(student(1), id, at(21), at(23));
    await handle.db.execute(sql`DELETE FROM idempotency_records`);

    const original = await createReservation(handle.db, {
      actor: student(1),
      idempotencyKey: key,
      resourceId: camera(2),
      startsAt: at(17),
      endsAt: at(21),
      now: NOW,
    });
    expect(original.status).toBe(201);
    const different = await createReservation(handle.db, {
      actor: student(1),
      idempotencyKey: key,
      resourceId: camera(2),
      startsAt: at(21),
      endsAt: at(23),
      now: NOW,
    });
    expect(different.status).toBe(422);
  });

  it("lets exactly one of several racing reschedules into one slot win", async () => {
    const ids = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => book(student(n), camera(2), at(n * 3 - 1), at(n * 3))),
    );
    const results = await Promise.all(
      ids.map((id, i) => move(student(i + 1), id, at(10, 14), at(12, 14))),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
  });

  it("never deadlocks when two bookings try to move into each other's slots", async () => {
    const a = await book(student(1), camera(2), at(17), at(19));
    const b = await book(student(2), camera(2), at(19), at(21));
    const runs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0 ? move(student(1), a, at(19), at(21)) : move(student(2), b, at(17), at(19)),
      ),
    );
    for (const r of runs) expect([200, 409]).toContain(r.status);
    const active = await handle.db
      .select()
      .from(reservations)
      .where(eq(reservations.status, "active"));
    expect(active).toHaveLength(2);
  });
});
