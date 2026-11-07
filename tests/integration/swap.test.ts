import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { reservations } from "../../src/lib/db/schema";
import {
  type Actor,
  cancelReservation,
  createReservation,
  swapReservations,
} from "../../src/lib/reservations/service";
import { connectTestDb, type LabFixture, resetDatabase, seedLab } from "./helpers";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const at = (hourUtc: number, day = 13): Date => new Date(Date.UTC(2026, 10, day, hourUtc));

const handle = connectTestDb(40);
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

const swap = (actor: Actor, firstId: string, secondId: string, key?: string) =>
  swapReservations(handle.db, {
    actor,
    idempotencyKey: key ?? crypto.randomUUID(),
    firstId,
    secondId,
    now: NOW,
  });

async function range(id: string) {
  const [row] = await handle.db.select().from(reservations).where(eq(reservations.id, id));
  return row;
}

beforeEach(async () => {
  await resetDatabase(handle);
  lab = await seedLab(handle);
});

afterAll(async () => {
  await handle.close();
});

describe("swapReservations", () => {
  it("exchanges the two ranges even though each sits inside the other's old range", async () => {
    const a = await book(student(1), camera(2), at(15), at(17));
    const b = await book(student(1), camera(2), at(19), at(23));
    const result = await swap(student(1), a, b);
    expect(result.status).toBe(200);
    expect((await range(a))?.startsAt).toEqual(at(19));
    expect((await range(a))?.endsAt).toEqual(at(23));
    expect((await range(b))?.startsAt).toEqual(at(15));
    expect((await range(b))?.endsAt).toEqual(at(17));
  });

  it("recomputes each blocked range from the item's buffer", async () => {
    // The seeded printer cap is one active booking per person; this test needs two.
    await handle.db.execute(
      sql`UPDATE categories SET max_active_per_user = 3 WHERE id = 'printer'`,
    );
    const a = await book(student(1), lab.printer.id, at(13), at(15));
    const b = await book(student(1), lab.printer.id, at(17), at(18));
    await swap(student(1), a, b);
    expect((await range(a))?.blockedUntil).toEqual(new Date(at(18).getTime() + 30 * 60_000));
    expect((await range(b))?.blockedUntil).toEqual(new Date(at(15).getTime() + 30 * 60_000));
  });

  it("keeps rejecting an ordinary overlap immediately (the constraint stays enforcing)", async () => {
    await book(student(1), camera(2), at(15), at(17));
    const clash = await createReservation(handle.db, {
      actor: student(2),
      idempotencyKey: crypto.randomUUID(),
      resourceId: camera(2),
      startsAt: at(16),
      endsAt: at(18),
      now: NOW,
    });
    expect(clash.status).toBe(409);
    const mode = await handle.db.execute(
      sql`SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'reservations_no_overlap'`,
    );
    expect(mode.rows[0]).toEqual({ condeferrable: true, condeferred: false });
  });

  it("validates the pair: same item, owner, state, and two different bookings", async () => {
    const a = await book(student(1), camera(2), at(15), at(17));
    const other = await book(student(1), camera(3), at(15), at(17));
    expect(await swap(student(1), a, other)).toMatchObject({
      status: 422,
      body: { code: "not_swappable" },
    });
    expect(await swap(student(1), a, a)).toMatchObject({ status: 422 });

    const theirs = await book(student(2), camera(2), at(19), at(21));
    expect((await swap(student(1), a, theirs)).status).toBe(404);
    expect((await swap(student(1), a, crypto.randomUUID())).status).toBe(404);

    const mine = await book(student(1), camera(2), at(21), at(23));
    await cancelReservation(handle.db, {
      actor: student(1),
      idempotencyKey: crypto.randomUUID(),
      reservationId: mine,
      now: NOW,
    });
    expect(await swap(student(1), a, mine)).toMatchObject({
      status: 409,
      body: { code: "already_cancelled" },
    });
    // Nothing moved.
    expect((await range(a))?.startsAt).toEqual(at(15));
  });

  it("refuses bookings that have started or ended", async () => {
    const a = await book(student(1), camera(2), at(15), at(17));
    const b = await book(student(1), camera(2), at(19), at(21));
    const later = new Date(at(16).getTime());
    const started = await swapReservations(handle.db, {
      actor: student(1),
      idempotencyKey: crypto.randomUUID(),
      firstId: a,
      secondId: b,
      now: later,
    });
    expect(started).toMatchObject({ status: 409, body: { code: "already_started" } });
  });

  it("replays for the same key (in either order) and rejects the key for another pair", async () => {
    const a = await book(student(1), camera(2), at(15), at(17));
    const b = await book(student(1), camera(2), at(19), at(21));
    const c = await book(student(1), camera(2), at(22), at(23));
    const key = crypto.randomUUID();
    const first = await swap(student(1), a, b, key);
    const retry = await swap(student(1), b, a, key);
    expect(retry).toMatchObject({ status: 200, replayed: true });
    expect(retry.body).toEqual(first.body);
    expect((await swap(student(1), a, c, key)).status).toBe(422);
    // The retry did not swap back.
    expect((await range(a))?.startsAt).toEqual(at(19));
  });

  it("fingerprints pre-migration rows (empty create_hash) before their ranges trade places", async () => {
    const keyA = crypto.randomUUID();
    const first = await createReservation(handle.db, {
      actor: student(1),
      idempotencyKey: keyA,
      resourceId: camera(2),
      startsAt: at(15),
      endsAt: at(17),
      now: NOW,
    });
    const a = (first.body["reservation"] as { id: string }).id;
    const b = await book(student(1), camera(2), at(19), at(21));
    await handle.db.execute(sql`UPDATE reservations SET create_hash = ''`);
    await swap(student(1), a, b);
    await handle.db.execute(sql`DELETE FROM idempotency_records`);

    const original = await createReservation(handle.db, {
      actor: student(1),
      idempotencyKey: keyA,
      resourceId: camera(2),
      startsAt: at(15),
      endsAt: at(17),
      now: NOW,
    });
    expect(original.status).toBe(201); // the original body is still recognised after the swap
    const swappedBody = await createReservation(handle.db, {
      actor: student(1),
      idempotencyKey: keyA,
      resourceId: camera(2),
      startsAt: at(19),
      endsAt: at(21),
      now: NOW,
    });
    expect(swappedBody.status).toBe(422);
  });

  it("never deadlocks when swaps over the same pair arrive in opposite orders", async () => {
    const a = await book(student(1), camera(2), at(15), at(17));
    const b = await book(student(1), camera(2), at(19), at(21));
    const runs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0 ? swap(student(1), a, b) : swap(student(1), b, a),
      ),
    );
    expect(runs.map((r) => r.status)).toEqual(Array(20).fill(200));
    // An even number of swaps leaves everything where it started, and nothing overlaps.
    expect((await range(a))?.startsAt).toEqual(at(15));
    expect((await range(b))?.startsAt).toEqual(at(19));
    const active = await handle.db
      .select()
      .from(reservations)
      .where(eq(reservations.status, "active"));
    expect(active).toHaveLength(2);
  });
});
