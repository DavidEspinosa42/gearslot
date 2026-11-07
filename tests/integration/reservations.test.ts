import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { reservations } from "../../src/lib/db/schema";
import {
  type Actor,
  cancelReservation,
  createReservation,
  getAvailability,
  listMyReservations,
} from "../../src/lib/reservations/service";
import { connectTestDb, type LabFixture, resetDatabase, seedLab } from "./helpers";

/** Monday 09:00 in Buenos Aires, the moment the week unlocks. */
const NOW = new Date("2026-11-09T12:00:00.000Z");
const FRIDAY_14 = new Date("2026-11-13T17:00:00.000Z"); // 14:00 local
const FRIDAY_18 = new Date("2026-11-13T21:00:00.000Z");
const FRIDAY_20 = new Date("2026-11-13T23:00:00.000Z");

const handle = connectTestDb();
let lab: LabFixture;

const student = (n: number): Actor => ({
  userId: `user-${String(n).padStart(3, "0")}`,
  displayName: `Student ${n}`,
});

function camera(n: 1 | 2 | 3): string {
  const found = lab.cameras[n - 1];
  if (found === undefined) throw new Error("fixture");
  return found.id;
}

function book(
  actor: Actor,
  resourceId: string,
  startsAt: Date,
  endsAt: Date,
  idempotencyKey: string = crypto.randomUUID(),
) {
  return createReservation(handle.db, {
    actor,
    idempotencyKey,
    resourceId,
    startsAt,
    endsAt,
    now: NOW,
  });
}

beforeEach(async () => {
  await resetDatabase(handle);
  lab = await seedLab(handle);
});

afterAll(async () => {
  await handle.close();
});

describe("createReservation", () => {
  it("confirms a free slot with a 201 and the booked interval", async () => {
    const result = await book(student(1), camera(2), FRIDAY_14, FRIDAY_18);
    expect(result.status).toBe(201);
    expect(result.replayed).toBe(false);
    expect(result.body["reservation"]).toMatchObject({
      resourceName: "Camera #2",
      startsAt: "2026-11-13T17:00:00.000Z",
      endsAt: "2026-11-13T21:00:00.000Z",
      blockedUntil: "2026-11-13T21:00:00.000Z",
      status: "active",
    });
  });

  it("accepts a booking that only touches the end of another (half-open)", async () => {
    expect((await book(student(1), camera(2), FRIDAY_14, FRIDAY_18)).status).toBe(201);
    expect((await book(student(2), camera(2), FRIDAY_18, FRIDAY_20)).status).toBe(201);
  });

  it("answers an overlap with 409 and suggests another unit and the next slot", async () => {
    await book(student(1), camera(2), FRIDAY_14, FRIDAY_18);
    const loser = await book(student(2), camera(2), FRIDAY_14, FRIDAY_18);
    expect(loser.status).toBe(409);
    expect(loser.body["code"]).toBe("conflict");
    const suggestions = loser.body["suggestions"] as {
      identicalUnits: { name: string }[];
      nextSlots: { startsAt: string; endsAt: string }[];
    };
    expect(suggestions.identicalUnits.map((u) => u.name)).toEqual(["Camera #1", "Camera #3"]);
    expect(suggestions.nextSlots[0]).toEqual({
      startsAt: "2026-11-13T21:00:00.000Z",
      endsAt: "2026-11-14T01:00:00.000Z",
    });
  });

  it("does not suggest a unit that is busy in that interval", async () => {
    await book(student(1), camera(2), FRIDAY_14, FRIDAY_18);
    await book(student(2), camera(1), FRIDAY_14, FRIDAY_18);
    const loser = await book(student(3), camera(2), FRIDAY_14, FRIDAY_18);
    const suggestions = loser.body["suggestions"] as { identicalUnits: { name: string }[] };
    expect(suggestions.identicalUnits.map((u) => u.name)).toEqual(["Camera #3"]);
  });

  it("counts the printer buffer toward conflicts", async () => {
    const start = new Date("2026-11-13T13:00:00.000Z");
    const end = new Date("2026-11-13T15:00:00.000Z");
    const first = await book(student(1), lab.printer.id, start, end);
    expect(first.body["reservation"]).toMatchObject({ blockedUntil: "2026-11-13T15:30:00.000Z" });

    const insideBuffer = await book(
      student(2),
      lab.printer.id,
      new Date("2026-11-13T15:15:00.000Z"),
      new Date("2026-11-13T16:00:00.000Z"),
    );
    expect(insideBuffer.status).toBe(409);
    const slots = (insideBuffer.body["suggestions"] as { nextSlots: { startsAt: string }[] })
      .nextSlots;
    expect(slots[0]?.startsAt).toBe("2026-11-13T15:30:00.000Z");

    const afterBuffer = await book(
      student(2),
      lab.printer.id,
      new Date("2026-11-13T15:30:00.000Z"),
      new Date("2026-11-13T16:00:00.000Z"),
    );
    expect(afterBuffer.status).toBe(201);
  });

  it("rejects rule violations with 422 and a stable code", async () => {
    const offGrid = await book(
      student(1),
      camera(1),
      new Date(FRIDAY_14.getTime() + 60_000),
      FRIDAY_18,
    );
    expect(offGrid).toMatchObject({ status: 422, body: { code: "not_aligned" } });

    const past = await book(
      student(1),
      camera(1),
      new Date("2026-11-09T11:45:00.000Z"),
      new Date("2026-11-09T12:30:00.000Z"),
    );
    expect(past.body["code"]).toBe("in_past");

    const tooFar = await book(
      student(1),
      camera(1),
      new Date("2026-12-20T12:00:00.000Z"),
      new Date("2026-12-20T13:00:00.000Z"),
    );
    expect(tooFar.body["code"]).toBe("beyond_horizon");

    const rows = await handle.db.select().from(reservations);
    expect(rows).toHaveLength(0);
  });

  it("answers 404 for an unknown item", async () => {
    const result = await book(student(1), crypto.randomUUID(), FRIDAY_14, FRIDAY_18);
    expect(result).toMatchObject({ status: 404, body: { code: "resource_not_found" } });
  });

  it("enforces the per-category cap and frees it when a booking is cancelled", async () => {
    const day = (d: number) => new Date(Date.UTC(2026, 10, 10 + d, 15, 0));
    const hourLater = (d: Date) => new Date(d.getTime() + 3_600_000);
    const ids: string[] = [];
    for (let d = 0; d < 3; d += 1) {
      const ok = await book(student(1), camera(1), day(d), hourLater(day(d)));
      expect(ok.status).toBe(201);
      ids.push((ok.body["reservation"] as { id: string }).id);
    }
    const fourth = await book(student(1), camera(1), day(5), hourLater(day(5)));
    expect(fourth).toMatchObject({ status: 409, body: { code: "quota_exceeded", limit: 3 } });

    const cancelled = await cancelReservation(handle.db, {
      actor: student(1),
      idempotencyKey: crypto.randomUUID(),
      reservationId: ids[0] ?? "",
      now: NOW,
    });
    expect(cancelled.status).toBe(200);
    expect((await book(student(1), camera(1), day(5), hourLater(day(5)))).status).toBe(201);
  });
});

describe("idempotency", () => {
  it("replays the stored response for the same key and body", async () => {
    const key = crypto.randomUUID();
    const first = await book(student(1), camera(2), FRIDAY_14, FRIDAY_18, key);
    const retry = await book(student(1), camera(2), FRIDAY_14, FRIDAY_18, key);
    expect(retry.status).toBe(201);
    expect(retry.replayed).toBe(true);
    expect(retry.body).toEqual(first.body);
    expect(await handle.db.select().from(reservations)).toHaveLength(1);
  });

  it("replays a stored 409 instead of retrying the booking", async () => {
    await book(student(1), camera(2), FRIDAY_14, FRIDAY_18);
    const key = crypto.randomUUID();
    const loser = await book(student(2), camera(2), FRIDAY_14, FRIDAY_18, key);
    await handle.db.execute(sql`UPDATE reservations SET status = 'cancelled'`);
    const retry = await book(student(2), camera(2), FRIDAY_14, FRIDAY_18, key);
    expect(retry).toMatchObject({ status: 409, replayed: true });
    expect(retry.body).toEqual(loser.body);
  });

  it("rejects a reused key carrying a different body with 422", async () => {
    const key = crypto.randomUUID();
    await book(student(1), camera(2), FRIDAY_14, FRIDAY_18, key);
    const reuse = await book(student(1), camera(2), FRIDAY_18, FRIDAY_20, key);
    expect(reuse).toMatchObject({ status: 422, body: { code: "idempotency_mismatch" } });
    expect(await handle.db.select().from(reservations)).toHaveLength(1);
  });

  it("still replays after the idempotency record was purged", async () => {
    const key = crypto.randomUUID();
    const first = await book(student(1), camera(2), FRIDAY_14, FRIDAY_18, key);
    await handle.db.execute(sql`DELETE FROM idempotency_records`);
    const retry = await book(student(1), camera(2), FRIDAY_14, FRIDAY_18, key);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    const other = await book(student(1), camera(2), FRIDAY_18, FRIDAY_20, key);
    expect(other).toMatchObject({ status: 422, body: { code: "idempotency_mismatch" } });
    expect(await handle.db.select().from(reservations)).toHaveLength(1);
  });

  it("scopes keys per user", async () => {
    const key = crypto.randomUUID();
    expect((await book(student(1), camera(1), FRIDAY_14, FRIDAY_18, key)).status).toBe(201);
    expect((await book(student(2), camera(2), FRIDAY_14, FRIDAY_18, key)).status).toBe(201);
  });
});

describe("cancelReservation", () => {
  async function bookedId(): Promise<string> {
    const created = await book(student(1), camera(2), FRIDAY_14, FRIDAY_18);
    return (created.body["reservation"] as { id: string }).id;
  }
  const cancel = (actor: Actor, reservationId: string, key: string = crypto.randomUUID()) =>
    cancelReservation(handle.db, { actor, idempotencyKey: key, reservationId, now: NOW });

  it("marks the row cancelled, keeps it, and frees the slot", async () => {
    const id = await bookedId();
    const result = await cancel(student(1), id);
    expect(result.status).toBe(200);
    const [row] = await handle.db.select().from(reservations).where(eq(reservations.id, id));
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelledAt).toEqual(NOW);
    expect((await book(student(2), camera(2), FRIDAY_14, FRIDAY_18)).status).toBe(201);
  });

  it("replays the same response for a retried cancel", async () => {
    const id = await bookedId();
    const key = crypto.randomUUID();
    const first = await cancel(student(1), id, key);
    const retry = await cancel(student(1), id, key);
    expect(retry).toMatchObject({ status: 200, replayed: true });
    expect(retry.body).toEqual(first.body);
  });

  it("answers 409 to a second cancel made with a new key", async () => {
    const id = await bookedId();
    await cancel(student(1), id);
    expect(await cancel(student(1), id)).toMatchObject({
      status: 409,
      body: { code: "already_cancelled" },
    });
  });

  it("treats someone else's reservation as missing", async () => {
    const id = await bookedId();
    expect(await cancel(student(2), id)).toMatchObject({
      status: 404,
      body: { code: "reservation_not_found" },
    });
    const [row] = await handle.db.select().from(reservations).where(eq(reservations.id, id));
    expect(row?.status).toBe("active");
  });
});

describe("reads", () => {
  it("lists a user's upcoming reservations and hides other people in availability", async () => {
    await book(student(1), camera(2), FRIDAY_14, FRIDAY_18);
    await book(student(2), camera(2), FRIDAY_18, FRIDAY_20);
    const mine = await listMyReservations(handle.db, student(1).userId, NOW);
    expect(mine.map((r) => r.resourceName)).toEqual(["Camera #2"]);

    const blocks = await getAvailability(
      handle.db,
      camera(2),
      { from: new Date("2026-11-13T00:00:00Z"), to: new Date("2026-11-14T00:00:00Z") },
      student(1).userId,
    );
    expect(blocks).toEqual([
      expect.objectContaining({ startsAt: "2026-11-13T17:00:00.000Z", mine: true }),
      expect.objectContaining({ startsAt: "2026-11-13T21:00:00.000Z", mine: false }),
    ]);
    expect(JSON.stringify(blocks)).not.toContain("user-002");
  });
});
