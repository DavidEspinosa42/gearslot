import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";
import { POST as createRoute } from "../../src/app/api/reservations/route";
import { GET as availabilityRoute } from "../../src/app/api/resources/[id]/availability/route";
import { connectTestDb, type LabFixture, resetDatabase, seedLab } from "./helpers";

/**
 * The reference scenario through the real route handlers: at Monday 09:00:00.000 in Buenos Aires
 * (12:00:00.000Z) forty students POST the same booking at once. The handlers read the clock with
 * `new Date()`, so the system time is pinned (only `Date`, never the timers the driver needs).
 */
const MONDAY_0900 = "2026-11-09T12:00:00.000Z";
const FRIDAY_14 = "2026-11-13T17:00:00.000Z";
const FRIDAY_18 = "2026-11-13T21:00:00.000Z";
const FRIDAY_20 = "2026-11-13T23:00:00.000Z";

const handle = connectTestDb(5);
let lab: LabFixture;

beforeAll(() => {
  process.env["DATABASE_URL"] = inject("databaseUrl");
  process.env["DATABASE_POOL_MAX"] = "50"; // all 40 requests really run at once
  delete process.env["DEV_USER_SUBJECT"];
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MONDAY_0900));
  await resetDatabase(handle);
  lab = await seedLab(handle);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await handle.close();
});

function booking(subject: string, resourceId: string, startsAt: string, endsAt: string): Request {
  return new Request("http://lab.test/api/reservations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sso-subject": subject,
      "x-sso-display-name": `Student ${subject}`,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({ resourceId, startsAt, endsAt }),
  });
}

describe("Monday 09:00:00.000, forty students, Camera #2, Friday 14:00-18:00", () => {
  it("answers exactly one 201 and thirty-nine problem+json 409s, never a 5xx", async () => {
    const camera = lab.cameras[1];
    if (camera === undefined) throw new Error("fixture");

    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        createRoute(
          booking(`user-${String(i + 1).padStart(3, "0")}`, camera.id, FRIDAY_14, FRIDAY_18),
        ),
      ),
    );

    expect(responses.map((r) => r.status).filter((s) => s >= 500)).toEqual([]);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    const losers = responses.filter((r) => r.status === 409);
    expect(losers).toHaveLength(39);
    for (const loser of losers) {
      expect(loser.headers.get("content-type")).toBe("application/problem+json");
    }

    const body = await losers[0]?.json();
    expect(body.code).toBe("conflict");
    expect(body.suggestions.identicalUnits.map((u: { name: string }) => u.name)).toEqual([
      "Camera #1",
      "Camera #3",
    ]);
    expect(body.suggestions.nextSlots[0].startsAt).toBe(FRIDAY_18);
  });

  it("accepts the touching 18:00-20:00 booking and shows both blocks in availability", async () => {
    const camera = lab.cameras[1];
    if (camera === undefined) throw new Error("fixture");

    const race = Array.from({ length: 40 }, (_, i) =>
      createRoute(
        booking(`user-${String(i + 1).padStart(3, "0")}`, camera.id, FRIDAY_14, FRIDAY_18),
      ),
    );
    const touching = createRoute(booking("user-041", camera.id, FRIDAY_18, FRIDAY_20));
    const [touchingResponse, ...raceResponses] = await Promise.all([touching, ...race]);

    expect(touchingResponse?.status).toBe(201);
    expect(raceResponses.filter((r) => r.status === 201)).toHaveLength(1);

    const read = await availabilityRoute(
      new Request(
        `http://lab.test/api/resources/${camera.id}/availability?from=2026-11-13T00:00:00Z&to=2026-11-14T00:00:00Z`,
        { headers: { "x-sso-subject": "viewer-1" } },
      ),
      { params: Promise.resolve({ id: camera.id }) },
    );
    const { blocks } = await read.json();
    expect(blocks.map((b: { startsAt: string }) => b.startsAt)).toEqual([FRIDAY_14, FRIDAY_18]);
  });
});
