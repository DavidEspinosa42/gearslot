import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { reservations, users } from "../../src/lib/db/schema";
import { purgeHistory } from "../../src/lib/reservations/purge";
import { connectTestDb, ensureUser, type LabFixture, resetDatabase, seedLab } from "./helpers";

const handle = connectTestDb(3);
let lab: LabFixture;
const NOW = new Date("2026-11-09T12:00:00.000Z");

beforeEach(async () => {
  await resetDatabase(handle);
  lab = await seedLab(handle);
});

afterAll(async () => {
  await handle.close();
});

async function add(
  userId: string,
  startIso: string,
  endIso: string,
  status: "active" | "cancelled",
) {
  await ensureUser(handle, userId);
  const camera = lab.cameras[0];
  if (camera === undefined) throw new Error("fixture");
  await handle.db.insert(reservations).values({
    resourceId: camera.id,
    userId,
    startsAt: new Date(startIso),
    endsAt: new Date(endIso),
    blockedUntil: new Date(endIso),
    status,
    idempotencyKey: crypto.randomUUID(),
  });
}

describe("purgeHistory", () => {
  it("removes history older than 12 months, keeps recent rows and their owners", async () => {
    await add("old-user", "2025-10-01T10:00:00Z", "2025-10-01T12:00:00Z", "active");
    await add("old-cancelled", "2025-09-01T10:00:00Z", "2025-09-01T12:00:00Z", "cancelled");
    await add("recent-user", "2026-10-01T10:00:00Z", "2026-10-01T12:00:00Z", "cancelled");
    await add("future-user", "2026-12-01T10:00:00Z", "2026-12-01T12:00:00Z", "active");

    const report = await purgeHistory(handle.db, NOW);
    expect(report).toMatchObject({ reservations: 2, users: 2 });

    const left = await handle.db.select({ userId: reservations.userId }).from(reservations);
    expect(left.map((r) => r.userId).sort()).toEqual(["future-user", "recent-user"]);
    const people = await handle.db.select({ id: users.id }).from(users);
    expect(people.map((u) => u.id).sort()).toEqual(["future-user", "recent-user"]);
  });

  it("drops idempotency records older than seven days only", async () => {
    await handle.db.execute(sql`
      INSERT INTO idempotency_records (user_id, key, operation, request_hash, status_code, response, created_at)
      VALUES ('u', 'old-key', 'create', 'h', 201, '{}', ${NOW.toISOString()}::timestamptz - interval '8 days'),
             ('u', 'new-key', 'create', 'h', 201, '{}', ${NOW.toISOString()}::timestamptz - interval '2 days')`);
    const report = await purgeHistory(handle.db, NOW);
    expect(report.idempotencyRecords).toBe(1);
    const left = await handle.db.execute(sql`SELECT key FROM idempotency_records`);
    expect(left.rows).toEqual([{ key: "new-key" }]);
  });

  it("uses the per-instance retention setting", async () => {
    await handle.db.execute(sql`UPDATE lab_settings SET retention_months = 1`);
    await add("two-months-ago", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", "active");
    expect((await purgeHistory(handle.db, NOW)).reservations).toBe(1);
  });
});
