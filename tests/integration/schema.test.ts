import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { reservations } from "../../src/lib/db/schema";
import { connectTestDb, ensureUser, type LabFixture, resetDatabase, seedLab } from "./helpers";

const handle = connectTestDb();
let lab: LabFixture;

const at = (iso: string): Date => new Date(iso);

async function insert(
  resourceId: string,
  start: string,
  end: string,
  options: {
    blockedUntil?: string;
    status?: "active" | "cancelled";
    key?: string;
    user?: string;
  } = {},
) {
  const userId = options.user ?? "user-001";
  await ensureUser(handle, userId);
  return handle.db.insert(reservations).values({
    resourceId,
    userId,
    startsAt: at(start),
    endsAt: at(end),
    blockedUntil: at(options.blockedUntil ?? end),
    status: options.status ?? "active",
    idempotencyKey: options.key ?? crypto.randomUUID(),
  });
}

/** Postgres error code of the first failure, unwrapping the driver wrapper. */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
      current = current.cause;
    }
    return "unknown";
  }
}

beforeEach(async () => {
  await resetDatabase(handle);
  lab = await seedLab(handle);
});

afterAll(async () => {
  await handle.close();
});

describe("migrations", () => {
  it("enable btree_gist and create the exclusion constraint", async () => {
    const extension = await handle.db.execute(
      sql`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`,
    );
    expect(extension.rows).toHaveLength(1);
    const constraint = await handle.db.execute(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'reservations_no_overlap'`,
    );
    expect(String(constraint.rows[0]?.["def"])).toContain("EXCLUDE USING gist");
  });

  it("keeps exactly one settings row", async () => {
    const rows = await handle.db.execute(sql`SELECT timezone, slot_minutes FROM lab_settings`);
    expect(rows.rows).toEqual([{ timezone: "America/Argentina/Buenos_Aires", slot_minutes: 15 }]);
    expect(
      await sqlState(handle.db.execute(sql`INSERT INTO lab_settings (id) VALUES (false)`)),
    ).toBe("23514");
  });
});

describe("no-overlap exclusion constraint", () => {
  it("rejects an overlapping active reservation with SQLSTATE 23P01", async () => {
    const [camera] = lab.cameras;
    if (camera === undefined) throw new Error("fixture");
    await insert(camera.id, "2026-12-04T17:00:00Z", "2026-12-04T21:00:00Z");
    expect(await sqlState(insert(camera.id, "2026-12-04T20:00:00Z", "2026-12-04T22:00:00Z"))).toBe(
      "23P01",
    );
  });

  it("allows touching endpoints because intervals are half-open", async () => {
    const [camera] = lab.cameras;
    if (camera === undefined) throw new Error("fixture");
    await insert(camera.id, "2026-12-04T17:00:00Z", "2026-12-04T21:00:00Z");
    expect(await sqlState(insert(camera.id, "2026-12-04T21:00:00Z", "2026-12-04T23:00:00Z"))).toBe(
      undefined,
    );
  });

  it("allows the same interval on a different resource", async () => {
    const [first, second] = lab.cameras;
    if (first === undefined || second === undefined) throw new Error("fixture");
    await insert(first.id, "2026-12-04T17:00:00Z", "2026-12-04T21:00:00Z");
    expect(await sqlState(insert(second.id, "2026-12-04T17:00:00Z", "2026-12-04T21:00:00Z"))).toBe(
      undefined,
    );
  });

  it("counts the buffer toward conflicts through blocked_until", async () => {
    await insert(lab.printer.id, "2026-12-04T13:00:00Z", "2026-12-04T15:00:00Z", {
      blockedUntil: "2026-12-04T15:30:00Z",
    });
    const insideBuffer = insert(lab.printer.id, "2026-12-04T15:15:00Z", "2026-12-04T16:00:00Z", {
      blockedUntil: "2026-12-04T16:30:00Z",
    });
    expect(await sqlState(insideBuffer)).toBe("23P01");
    const afterBuffer = insert(lab.printer.id, "2026-12-04T15:30:00Z", "2026-12-04T16:00:00Z", {
      blockedUntil: "2026-12-04T16:30:00Z",
    });
    expect(await sqlState(afterBuffer)).toBe(undefined);
  });

  it("frees the slot when a reservation is cancelled", async () => {
    const [camera] = lab.cameras;
    if (camera === undefined) throw new Error("fixture");
    await insert(camera.id, "2026-12-04T17:00:00Z", "2026-12-04T21:00:00Z", { key: "first" });
    await handle.db.execute(
      sql`UPDATE reservations SET status = 'cancelled' WHERE idempotency_key = 'first'`,
    );
    expect(await sqlState(insert(camera.id, "2026-12-04T17:00:00Z", "2026-12-04T21:00:00Z"))).toBe(
      undefined,
    );
  });

  it("ignores cancelled rows when inserting an overlapping one", async () => {
    const [camera] = lab.cameras;
    if (camera === undefined) throw new Error("fixture");
    await insert(camera.id, "2026-12-04T17:00:00Z", "2026-12-04T21:00:00Z", {
      status: "cancelled",
    });
    expect(await sqlState(insert(camera.id, "2026-12-04T18:00:00Z", "2026-12-04T19:00:00Z"))).toBe(
      undefined,
    );
  });
});

describe("table checks", () => {
  it("reject empty ranges and a blocked_until before the end", async () => {
    const [camera] = lab.cameras;
    if (camera === undefined) throw new Error("fixture");
    expect(await sqlState(insert(camera.id, "2026-12-04T17:00:00Z", "2026-12-04T17:00:00Z"))).toBe(
      "23514",
    );
    expect(
      await sqlState(
        insert(camera.id, "2026-12-04T17:00:00Z", "2026-12-04T18:00:00Z", {
          blockedUntil: "2026-12-04T17:30:00Z",
        }),
      ),
    ).toBe("23514");
  });

  it("reject a repeated idempotency key for the same user", async () => {
    const [first, second] = lab.cameras;
    if (first === undefined || second === undefined) throw new Error("fixture");
    await insert(first.id, "2026-12-04T17:00:00Z", "2026-12-04T18:00:00Z", { key: "same" });
    expect(
      await sqlState(
        insert(second.id, "2026-12-05T17:00:00Z", "2026-12-05T18:00:00Z", { key: "same" }),
      ),
    ).toBe("23505");
  });
});
