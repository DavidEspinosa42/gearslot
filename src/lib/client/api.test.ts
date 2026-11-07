import { describe, expect, it } from "vitest";
import { attemptIsFinished, createApi, newAttempt, type Outcome } from "./api";

function stub(responses: (Response | Error)[]) {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetchImpl = (async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    const next = responses.shift();
    if (next === undefined) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { api: createApi(fetchImpl), calls };
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const headerOf = (init: RequestInit, name: string) =>
  (init.headers as Record<string, string>)[name];

describe("book", () => {
  it("sends the attempt key and ISO instants", async () => {
    const { api, calls } = stub([jsonResponse(201, { reservation: { id: "r1" } })]);
    const attempt = newAttempt();
    const outcome = await api.book(
      attempt,
      "res-1",
      Date.UTC(2026, 10, 13, 17),
      Date.UTC(2026, 10, 13, 21),
    );
    expect(outcome.kind).toBe("ok");
    expect(headerOf(calls[0]?.init ?? {}, "Idempotency-Key")).toBe(attempt.key);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      resourceId: "res-1",
      startsAt: "2026-11-13T17:00:00.000Z",
      endsAt: "2026-11-13T21:00:00.000Z",
    });
  });

  it("classifies a 409 as a problem carrying suggestions", async () => {
    const suggestions = {
      identicalUnits: [{ resourceId: "c1", name: "Camera #1" }],
      nextSlots: [],
    };
    const { api } = stub([jsonResponse(409, { code: "conflict", title: "Taken", suggestions })]);
    const outcome = await api.book(newAttempt(), "r", 0, 1);
    expect(outcome).toMatchObject({
      kind: "problem",
      status: 409,
      problem: { code: "conflict", suggestions },
    });
  });

  it("reports flaky Wi-Fi as network and leaves the attempt open", async () => {
    const { api } = stub([new TypeError("fetch failed")]);
    const outcome = await api.book(newAttempt(), "r", 0, 1);
    expect(outcome).toEqual({ kind: "network" });
    expect(attemptIsFinished(outcome)).toBe(false);
  });

  it("flags replayed answers", async () => {
    const { api } = stub([
      jsonResponse(201, { reservation: {} }, { "idempotent-replayed": "true" }),
    ]);
    const outcome = await api.book(newAttempt(), "r", 0, 1);
    expect(outcome).toMatchObject({ kind: "ok", replayed: true });
  });

  it("maps 401 to unauthorized and survives a non-JSON error page", async () => {
    const { api } = stub([
      jsonResponse(401, {}),
      new Response("<html>bad gateway</html>", { status: 502 }),
    ]);
    expect((await api.mine()).kind).toBe("unauthorized");
    const bad = await api.mine();
    expect(bad).toMatchObject({ kind: "problem", status: 502 });
    expect(attemptIsFinished(bad)).toBe(false);
  });
});

describe("attemptIsFinished", () => {
  const problem = (status: number): Outcome<never> => ({
    kind: "problem",
    status,
    problem: { code: "x", title: "x", status },
  });

  it("closes the attempt on definitive answers only", () => {
    expect(attemptIsFinished({ kind: "ok", status: 201, data: {}, replayed: false })).toBe(true);
    expect(attemptIsFinished(problem(409))).toBe(true);
    expect(attemptIsFinished(problem(422))).toBe(true);
    expect(attemptIsFinished(problem(503))).toBe(false);
    expect(attemptIsFinished({ kind: "unauthorized" })).toBe(false);
  });
});

describe("availability", () => {
  it("returns blocks as epoch milliseconds with the buffer included", async () => {
    const { api, calls } = stub([
      jsonResponse(200, {
        blocks: [
          {
            startsAt: "2026-11-13T17:00:00.000Z",
            endsAt: "2026-11-13T21:00:00.000Z",
            blockedUntil: "2026-11-13T21:30:00.000Z",
            mine: true,
          },
        ],
      }),
    ]);
    const outcome = await api.availability("res-1", 0, 1000);
    expect(calls[0]?.path).toContain("/api/resources/res-1/availability?from=");
    expect(outcome).toMatchObject({
      kind: "ok",
      data: [
        {
          start: Date.parse("2026-11-13T17:00:00Z"),
          end: Date.parse("2026-11-13T21:30:00Z"),
          mine: true,
        },
      ],
    });
  });
});
