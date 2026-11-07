import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { GET as getMe } from "../../src/app/api/me/route";
import { POST as cancelRoute } from "../../src/app/api/reservations/[id]/cancel/route";
import { POST as createRoute, GET as listRoute } from "../../src/app/api/reservations/route";
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
