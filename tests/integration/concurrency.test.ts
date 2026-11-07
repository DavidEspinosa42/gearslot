import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { overlaps } from "../../src/lib/booking/interval";
import { reservations } from "../../src/lib/db/schema";
import { pgErrorCode } from "../../src/lib/reservations/pg-errors";
import {
  type Actor,
  cancelReservation,
  createReservation,
  lockReservationsInOrder,
} from "../../src/lib/reservations/service";
import { connectTestDb, ensureUser, type LabFixture, resetDatabase, seedLab } from "./helpers";

const NOW = new Date("2026-11-09T12:00:00.000Z"); // Monday 09:00:00.000 in Buenos Aires
const FRIDAY_14 = new Date("2026-11-13T17:00:00.000Z");
const FRIDAY_18 = new Date("2026-11-13T21:00:00.000Z");
const FRIDAY_20 = new Date("2026-11-13T23:00:00.000Z");

// A pool at least as large as the fan-out, so requests really run on separate connections.
const handle = connectTestDb(60);
let lab: LabFixture;

const student = (n: number): Actor => ({
  userId: `user-${String(n).padStart(3, "0")}`,
  displayName: `Student ${n}`,
});

function cameraId(n: number): string {
  const found = lab.cameras[n - 1];
  if (found === undefined) throw new Error("fixture");
  return found.id;
}

const create = (actor: Actor, resourceId: string, startsAt: Date, endsAt: Date, key?: string) =>
  createReservation(handle.db, {
    actor,
    idempotencyKey: key ?? crypto.randomUUID(),
    resourceId,
    startsAt,
    endsAt,
    now: NOW,
  });

beforeEach(async () => {
  await resetDatabase(handle);
  lab = await seedLab(handle);
});

afterAll(async () => {
  await handle.close();
});

describe("reference scenario: 40 students, one slot, one instant", () => {
  it("commits exactly one winner and answers 39 clean 409s with suggestions", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        create(student(i + 1), cameraId(2), FRIDAY_14, FRIDAY_18),
      ),
    );

    const winners = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(39);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);

    for (const loser of losers) {
      expect(loser.body["code"]).toBe("conflict");
      const suggestions = loser.body["suggestions"] as {
        identicalUnits: { name: string }[];
        nextSlots: unknown[];
      };
      expect(suggestions.identicalUnits.map((u) => u.name)).toEqual(["Camera #1", "Camera #3"]);
      expect(suggestions.nextSlots.length).toBeGreaterThan(0);
    }

    const rows = await handle.db
      .select()
      .from(reservations)
      .where(eq(reservations.status, "active"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resourceId).toBe(cameraId(2));
  });

  it("lets the touching Friday 18:00-20:00 booking win while the race rages", async () => {
    const race = Array.from({ length: 40 }, (_, i) =>
      create(student(i + 1), cameraId(2), FRIDAY_14, FRIDAY_18),
    );
    const touching = create(student(41), cameraId(2), FRIDAY_18, FRIDAY_20);
    const [touchingResult, ...results] = await Promise.all([touching, ...race]);

    expect(touchingResult?.status).toBe(201);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(39);
  });

  it("books different identical units in parallel without interference", async () => {
    const results = await Promise.all(
      [1, 2, 3].flatMap((unit) =>
        Array.from({ length: 10 }, (_, i) =>
          create(student(unit * 100 + i), cameraId(unit), FRIDAY_14, FRIDAY_18),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(27);
  });
});

describe("the constraint alone (no service, no advisory lock)", () => {
  it("lets exactly one of 30 raw concurrent inserts commit", async () => {
    for (let i = 1; i <= 30; i += 1) await ensureUser(handle, student(i).userId);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        handle.db.insert(reservations).values({
          resourceId: cameraId(2),
          userId: student(i + 1).userId,
          startsAt: FRIDAY_14,
          endsAt: FRIDAY_18,
          blockedUntil: FRIDAY_18,
          idempotencyKey: crypto.randomUUID(),
        }),
      ),
    );
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        // 23P01 is the clean conflict. 40P01 is PostgreSQL breaking a wait cycle between racers;
        // the service avoids it with a per-resource lock and retries it if it still happens.
        expect(["23P01", "40P01"]).toContain(pgErrorCode(outcome.reason));
      }
    }
    expect(await handle.db.select().from(reservations)).toHaveLength(1);
  });
});

describe("randomised stress", () => {
  /** Small deterministic PRNG so a failure is reproducible. */
  function lcg(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  it("never leaves two overlapping active reservations and never answers 500", async () => {
    const random = lcg(20261109);
    const slot = 15 * 60_000;
    const base = FRIDAY_14.getTime();
    const requests = Array.from({ length: 150 }, (_, i) => {
      const startSlot = Math.floor(random() * 24);
      const lengthSlots = 1 + Math.floor(random() * 8);
      const unit = random() < 0.5 ? 1 : 2;
      return create(
        student(1 + (i % 60)),
        cameraId(unit),
        new Date(base + startSlot * slot),
        new Date(base + (startSlot + lengthSlots) * slot),
      );
    });
    const results = await Promise.all(requests);

    const statuses = new Set(results.map((r) => r.status));
    for (const status of statuses) expect([201, 409]).toContain(status);

    const active = await handle.db
      .select()
      .from(reservations)
      .where(eq(reservations.status, "active"));
    expect(active).toHaveLength(results.filter((r) => r.status === 201).length);
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const a = active[i];
        const b = active[j];
        if (a === undefined || b === undefined || a.resourceId !== b.resourceId) continue;
        expect(
          overlaps(
            { start: a.startsAt.getTime(), end: a.blockedUntil.getTime() },
            { start: b.startsAt.getTime(), end: b.blockedUntil.getTime() },
          ),
        ).toBe(false);
      }
    }
  });
});

describe("idempotency under concurrency", () => {
  it("collapses ten simultaneous copies of one request into one booking", async () => {
    const key = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => create(student(1), cameraId(2), FRIDAY_14, FRIDAY_18, key)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const ids = new Set(results.map((r) => (r.body["reservation"] as { id: string }).id));
    expect(ids.size).toBe(1);
    expect(await handle.db.select().from(reservations)).toHaveLength(1);
  });

  it("cancels once when ten simultaneous copies of one cancel arrive", async () => {
    const created = await create(student(1), cameraId(2), FRIDAY_14, FRIDAY_18);
    const reservationId = (created.body["reservation"] as { id: string }).id;
    const key = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        cancelReservation(handle.db, {
          actor: student(1),
          idempotencyKey: key,
          reservationId,
          now: NOW,
        }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it("cancels once when different keys race, answering the rest with 409", async () => {
    const created = await create(student(1), cameraId(2), FRIDAY_14, FRIDAY_18);
    const reservationId = (created.body["reservation"] as { id: string }).id;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        cancelReservation(handle.db, {
          actor: student(1),
          idempotencyKey: crypto.randomUUID(),
          reservationId,
          now: NOW,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
  });
});

describe("category cap under concurrency", () => {
  it("lets one user hold exactly the cap when requests arrive together", async () => {
    const actor = student(1);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        create(
          actor,
          cameraId(1),
          new Date(FRIDAY_14.getTime() + i * 43_200_000),
          new Date(FRIDAY_14.getTime() + i * 43_200_000 + 3_600_000),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const rejected = results.filter((r) => r.status === 409);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((r) => r.body["code"] === "quota_exceeded")).toBe(true);
    const held = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(reservations)
      .where(and(eq(reservations.userId, actor.userId), eq(reservations.status, "active")));
    expect(held[0]?.n).toBe(3);
  });
});

describe("multi-row locking", () => {
  it("takes locks in ascending id order so opposite request orders cannot deadlock", async () => {
    const a = await create(student(1), cameraId(1), FRIDAY_14, FRIDAY_18);
    const b = await create(student(2), cameraId(2), FRIDAY_14, FRIDAY_18);
    const ids = [a, b].map((r) => (r.body["reservation"] as { id: string }).id);
    const [first, second] = ids;
    if (first === undefined || second === undefined) throw new Error("setup");

    const runs = Array.from({ length: 40 }, (_, i) =>
      handle.db.transaction(async (tx) => {
        const locked = await lockReservationsInOrder(
          tx,
          i % 2 === 0 ? [first, second] : [second, first],
        );
        await tx.execute(sql`SELECT pg_sleep(0.005)`);
        return locked.map((row) => row.id);
      }),
    );
    const outcomes = await Promise.all(runs);
    const expected = [first, second].sort();
    for (const outcome of outcomes) expect(outcome).toEqual(expected);
  });
});
