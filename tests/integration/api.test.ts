import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { GET as getMe } from "../../src/app/api/me/route";
import { POST as cancelRoute } from "../../src/app/api/reservations/[id]/cancel/route";
import { POST as rescheduleRoute } from "../../src/app/api/reservations/[id]/reschedule/route";
import { POST as createRoute, GET as listRoute } from "../../src/app/api/reservations/route";
import { POST as swapRoute } from "../../src/app/api/reservations/swap/route";
import { GET as availabilityRoute } from "../../src/app/api/resources/[id]/availability/route";
import { GET as resourcesRoute } from "../../src/app/api/resources/route";
import { connectTestDb, type LabFixture, resetDatabase, seedLab } from "./helpers";

const handle = connectTestDb(5);
let lab: LabFixture;

beforeAll(() => {
  process.env["DATABASE_URL"] = inject("databaseUrl");
  process.env["DATABASE_POOL_MAX"] = "5";
  delete process.env["DEV_USER_SUBJECT"];
});

beforeEach(async () => {
  await resetDatabase(handle);
  lab = await seedLab(handle);
});

afterAll(async () => {
  await handle.close();
});

const SLOT = 15 * 60_000;
/** A slot-aligned instant `hours` from now (the routes use the real clock). */
const inHours = (hours: number): string =>
  new Date(Math.ceil((Date.now() + hours * 3_600_000) / SLOT) * SLOT).toISOString();

const as = (subject: string, extra: Record<string, string> = {}): Record<string, string> => ({
  "x-sso-subject": subject,
  "x-sso-display-name": `Person ${subject}`,
  ...extra,
});

function post(path: string, headers: Record<string, string>, body?: unknown): Request {
  return new Request(`http://lab.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const get = (path: string, headers: Record<string, string>): Request =>
  new Request(`http://lab.test${path}`, { headers });

function cameraId(n: number): string {
  const found = lab.cameras[n - 1];
  if (found === undefined) throw new Error("fixture");
  return found.id;
}

describe("authentication", () => {
  it("answers 401 problem+json without an SSO identity", async () => {
    const response = await getMe(get("/api/me", {}));
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("rejects a malformed subject", async () => {
    expect((await getMe(get("/api/me", { "x-sso-subject": "has space" }))).status).toBe(401);
  });

  it("returns only the opaque id and display name", async () => {
    const response = await getMe(get("/api/me", as("sub-1")));
    expect(await response.json()).toEqual({ userId: "sub-1", displayName: "Person sub-1" });
  });
});

describe("POST /api/reservations", () => {
  const body = () => ({ resourceId: cameraId(2), startsAt: inHours(48), endsAt: inHours(52) });

  it("requires an Idempotency-Key", async () => {
    const response = await createRoute(post("/api/reservations", as("sub-1"), body()));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "missing_idempotency_key" });
  });

  it("rejects bad JSON and bad bodies with 400", async () => {
    const headers = as("sub-1", { "idempotency-key": crypto.randomUUID() });
    const bad = new Request("http://lab.test/api/reservations", {
      method: "POST",
      headers,
      body: "{nope",
    });
    expect((await createRoute(bad)).status).toBe(400);
    const wrong = await createRoute(
      post("/api/reservations", headers, { resourceId: "x", startsAt: "yesterday", endsAt: 5 }),
    );
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "invalid_request" });
  });

  it("books, replays on retry, and lists the booking", async () => {
    const headers = as("sub-1", { "idempotency-key": crypto.randomUUID() });
    const created = await createRoute(post("/api/reservations", headers, body()));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const first = await created.json();

    const retry = await createRoute(post("/api/reservations", headers, body()));
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(await retry.json()).toEqual(first);

    const listed = await (await listRoute(get("/api/reservations", as("sub-1")))).json();
    expect(listed.reservations).toHaveLength(1);
  });

  it("answers a taken slot with 409 and suggestions in problem+json", async () => {
    await createRoute(
      post("/api/reservations", as("sub-1", { "idempotency-key": crypto.randomUUID() }), body()),
    );
    const lost = await createRoute(
      post("/api/reservations", as("sub-2", { "idempotency-key": crypto.randomUUID() }), body()),
    );
    expect(lost.status).toBe(409);
    expect(lost.headers.get("content-type")).toBe("application/problem+json");
    const problem = await lost.json();
    expect(problem.code).toBe("conflict");
    expect(problem.suggestions.identicalUnits).toHaveLength(2);
  });

  it("answers 422 for a rule violation", async () => {
    const response = await createRoute(
      post("/api/reservations", as("sub-1", { "idempotency-key": crypto.randomUUID() }), {
        resourceId: cameraId(1),
        startsAt: inHours(48),
        endsAt: inHours(48 + 100),
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "too_long" });
  });
});

describe("cancel", () => {
  it("cancels once and refuses to cancel someone else's booking", async () => {
    const created = await createRoute(
      post("/api/reservations", as("sub-1", { "idempotency-key": crypto.randomUUID() }), {
        resourceId: cameraId(2),
        startsAt: inHours(48),
        endsAt: inHours(52),
      }),
    );
    const { reservation } = await created.json();
    const params = { params: Promise.resolve({ id: reservation.id as string }) };

    const stranger = await cancelRoute(
      post(
        `/api/reservations/${reservation.id}/cancel`,
        as("sub-2", { "idempotency-key": "stranger-key-1" }),
      ),
      params,
    );
    expect(stranger.status).toBe(404);

    const key = crypto.randomUUID();
    const done = await cancelRoute(
      post(`/api/reservations/${reservation.id}/cancel`, as("sub-1", { "idempotency-key": key })),
      params,
    );
    expect(done.status).toBe(200);
    const again = await cancelRoute(
      post(`/api/reservations/${reservation.id}/cancel`, as("sub-1", { "idempotency-key": key })),
      params,
    );
    expect(again.headers.get("idempotent-replayed")).toBe("true");
  });

  it("answers 404 for a malformed id", async () => {
    const response = await cancelRoute(
      post("/api/reservations/nope/cancel", as("sub-1", { "idempotency-key": "some-key-123" })),
      { params: Promise.resolve({ id: "nope" }) },
    );
    expect(response.status).toBe(404);
  });
});

describe("reads", () => {
  it("returns lab rules with the items", async () => {
    const payload = await (await resourcesRoute(get("/api/resources", as("sub-1")))).json();
    expect(payload.lab).toMatchObject({
      timezone: "America/Argentina/Buenos_Aires",
      slotMinutes: 15,
    });
    expect(payload.resources).toHaveLength(4);
    expect(
      payload.resources.find((r: { name: string }) => r.name === "Prusa MK4").bufferMinutes,
    ).toBe(30);
  });

  it("returns availability blocks without identifying other people", async () => {
    await createRoute(
      post("/api/reservations", as("sub-1", { "idempotency-key": crypto.randomUUID() }), {
        resourceId: cameraId(2),
        startsAt: inHours(48),
        endsAt: inHours(52),
      }),
    );
    const url = `/api/resources/${cameraId(2)}/availability?from=${encodeURIComponent(inHours(24))}&to=${encodeURIComponent(inHours(96))}`;
    const params = { params: Promise.resolve({ id: cameraId(2) }) };
    const text = await (await availabilityRoute(get(url, as("sub-2")), params)).text();
    const payload = JSON.parse(text);
    expect(payload.blocks).toHaveLength(1);
    expect(payload.blocks[0].mine).toBe(false);
    expect(text).not.toContain("sub-1");
  });

  it("validates the availability window", async () => {
    const params = { params: Promise.resolve({ id: cameraId(2) }) };
    const reversed = await availabilityRoute(
      get(
        `/api/resources/${cameraId(2)}/availability?from=${inHours(5)}&to=${inHours(1)}`,
        as("sub-1"),
      ),
      params,
    );
    expect(reversed.status).toBe(422);
    const missing = await availabilityRoute(
      get(`/api/resources/${cameraId(2)}/availability`, as("sub-1")),
      params,
    );
    expect(missing.status).toBe(422);
  });
});

describe("reschedule", () => {
  it("moves a booking, replays on retry, and answers 409 on a clash", async () => {
    const created = await createRoute(
      post("/api/reservations", as("sub-1", { "idempotency-key": crypto.randomUUID() }), {
        resourceId: cameraId(2),
        startsAt: inHours(48),
        endsAt: inHours(52),
      }),
    );
    const { reservation } = await created.json();
    await createRoute(
      post("/api/reservations", as("sub-2", { "idempotency-key": crypto.randomUUID() }), {
        resourceId: cameraId(2),
        startsAt: inHours(52),
        endsAt: inHours(56),
      }),
    );
    const params = { params: Promise.resolve({ id: reservation.id as string }) };
    const path = `/api/reservations/${reservation.id}/reschedule`;

    const clash = await rescheduleRoute(
      post(path, as("sub-1", { "idempotency-key": crypto.randomUUID() }), {
        startsAt: inHours(50),
        endsAt: inHours(54),
      }),
      params,
    );
    expect(clash.status).toBe(409);

    const key = crypto.randomUUID();
    const body = { startsAt: inHours(60), endsAt: inHours(64) };
    const moved = await rescheduleRoute(
      post(path, as("sub-1", { "idempotency-key": key }), body),
      params,
    );
    expect(moved.status).toBe(200);
    const retry = await rescheduleRoute(
      post(path, as("sub-1", { "idempotency-key": key }), body),
      params,
    );
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
  });

  it("requires a key and a valid body", async () => {
    const id = crypto.randomUUID();
    const params = { params: Promise.resolve({ id }) };
    const noKey = await rescheduleRoute(
      post(`/api/reservations/${id}/reschedule`, as("sub-1"), {}),
      params,
    );
    expect(noKey.status).toBe(400);
    const badBody = await rescheduleRoute(
      post(
        `/api/reservations/${id}/reschedule`,
        as("sub-1", { "idempotency-key": "some-key-123" }),
        {
          startsAt: "x",
        },
      ),
      params,
    );
    expect(badBody.status).toBe(400);
  });
});

describe("swap", () => {
  const create = async (subject: string, startHours: number, endHours: number) => {
    const response = await createRoute(
      post("/api/reservations", as(subject, { "idempotency-key": crypto.randomUUID() }), {
        resourceId: cameraId(2),
        startsAt: inHours(startHours),
        endsAt: inHours(endHours),
      }),
    );
    return (await response.json()).reservation as { id: string; startsAt: string };
  };

  it("exchanges two of your bookings, replays on retry, and refuses someone else's", async () => {
    const a = await create("sub-1", 48, 50);
    const b = await create("sub-1", 60, 64);
    const stranger = await create("sub-2", 72, 74);
    const key = crypto.randomUUID();
    const body = { firstId: a.id, secondId: b.id };

    const done = await swapRoute(
      post("/api/reservations/swap", as("sub-1", { "idempotency-key": key }), body),
    );
    expect(done.status).toBe(200);
    const payload = await done.json();
    expect(payload.reservations).toHaveLength(2);
    expect(payload.reservations[0].startsAt).toBe(b.startsAt);

    const retry = await swapRoute(
      post("/api/reservations/swap", as("sub-1", { "idempotency-key": key }), body),
    );
    expect(retry.headers.get("idempotent-replayed")).toBe("true");

    const refused = await swapRoute(
      post("/api/reservations/swap", as("sub-1", { "idempotency-key": crypto.randomUUID() }), {
        firstId: a.id,
        secondId: stranger.id,
      }),
    );
    expect(refused.status).toBe(404);
  });

  it("accepts upper-case UUIDs and treats them as the same request on replay", async () => {
    const a = await create("sub-1", 48, 50);
    const b = await create("sub-1", 60, 64);
    const key = crypto.randomUUID();
    const upper = { firstId: a.id.toUpperCase(), secondId: b.id.toUpperCase() };
    const done = await swapRoute(
      post("/api/reservations/swap", as("sub-1", { "idempotency-key": key }), upper),
    );
    expect(done.status).toBe(200);
    const replay = await swapRoute(
      post("/api/reservations/swap", as("sub-1", { "idempotency-key": key }), {
        firstId: b.id,
        secondId: a.id,
      }),
    );
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
  });

  it("books with an upper-case resource id", async () => {
    const response = await createRoute(
      post("/api/reservations", as("sub-1", { "idempotency-key": crypto.randomUUID() }), {
        resourceId: cameraId(1).toUpperCase(),
        startsAt: inHours(48),
        endsAt: inHours(50),
      }),
    );
    expect(response.status).toBe(201);
  });

  it("requires a key and two valid ids", async () => {
    const noKey = await swapRoute(post("/api/reservations/swap", as("sub-1"), {}));
    expect(noKey.status).toBe(400);
    const bad = await swapRoute(
      post("/api/reservations/swap", as("sub-1", { "idempotency-key": "some-key-123" }), {
        firstId: "x",
        secondId: "y",
      }),
    );
    expect(bad.status).toBe(400);
  });
});
