/**
 * The reference scenario over real HTTP, against a running server (`pnpm build && pnpm start`):
 * 40 students POST "Camera #2, next Friday 14:00-18:00" at once, each with its own SSO identity
 * header. Run it with BASE_URL pointing at the server. Dummy users only.
 *
 * It uses the real clock, so it cannot be "Monday 09:00"; the fixed-clock version of the same race
 * lives in tests/integration/api-race.test.ts.
 */
import { isDeepStrictEqual } from "node:util";
import { nextFriday } from "./lib/friday";

const BASE_URL = process.env["BASE_URL"] ?? "http://localhost:3000";
const STUDENTS = 40;
const user = (n: number): string => `user-${String(n).padStart(3, "0")}`;
const headers = (n: number, key?: string): Record<string, string> => ({
  "content-type": "application/json",
  "x-sso-subject": user(n),
  "x-sso-display-name": `Student ${n}`,
  ...(key === undefined ? {} : { "idempotency-key": key }),
});

const lab = (await (await fetch(`${BASE_URL}/api/resources`, { headers: headers(1) })).json()) as {
  lab: { timezone: string };
  resources: { id: string; name: string }[];
};
const camera = lab.resources.find((r) => r.name === "Camera #2");
if (camera === undefined) throw new Error("Camera #2 is missing; run pnpm db:seed");

const { key: friday, at } = nextFriday(lab.lab.timezone);
const body = (start: Date, end: Date) =>
  JSON.stringify({
    resourceId: camera.id,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
  });
const book = (n: number, key: string, start: Date, end: Date) =>
  fetch(`${BASE_URL}/api/reservations`, {
    method: "POST",
    headers: headers(n, key),
    body: body(start, end),
  });

// The scenario needs an empty slot. Over HTTP there is no way to clear earlier runs (cancelling is
// per user), so say so instead of reporting a misleading failure; `pnpm scenario` can reset its own.
const taken = (await (
  await fetch(
    `${BASE_URL}/api/resources/${camera.id}/availability?from=${encodeURIComponent(at(13).toISOString())}&to=${encodeURIComponent(at(21).toISOString())}`,
    { headers: headers(1) },
  )
).json()) as { blocks: unknown[] };
if (taken.blocks.length > 0) {
  console.error(
    `Camera #2 already has bookings on ${friday}. Run this against a fresh database (pnpm db:migrate && pnpm db:seed).`,
  );
  process.exit(2);
}

console.log(`Camera #2, ${friday} 14:00-18:00 (${lab.lab.timezone}) via ${BASE_URL}`);
const keys = Array.from({ length: STUDENTS }, () => crypto.randomUUID());
const started = performance.now();
const responses = await Promise.all(keys.map((key, i) => book(i + 1, key, at(14), at(18))));
const elapsed = Math.round(performance.now() - started);

const bodies = await Promise.all(
  responses.map((r) => r.json() as Promise<Record<string, unknown>>),
);
const statuses = responses.map((r) => r.status);
const winners = statuses.filter((s) => s === 201).length;
const conflicts = statuses.filter((s) => s === 409).length;
const other = statuses.filter((s) => s !== 201 && s !== 409);
const problemTypes = new Set(
  responses.filter((r) => r.status === 409).map((r) => r.headers.get("content-type")),
);
console.log(
  `  ${winners} confirmed, ${conflicts} conflicts, ${other.length} other (${elapsed} ms)`,
);

const touching = await book(STUDENTS + 1, crypto.randomUUID(), at(18), at(20));
console.log(`18:00-20:00 touching the winner: ${touching.status === 201 ? "confirmed" : "FAILED"}`);

const winnerIndex = statuses.indexOf(201);
const retry =
  winnerIndex < 0
    ? undefined
    : await book(winnerIndex + 1, keys[winnerIndex] ?? "", at(14), at(18));
const replayed =
  retry !== undefined &&
  retry.status === 201 &&
  retry.headers.get("idempotent-replayed") === "true" &&
  isDeepStrictEqual(await retry.json(), bodies[winnerIndex]);
console.log(`winner retries with the same key: ${replayed ? "same booking returned" : "FAILED"}`);

const ok =
  winners === 1 &&
  conflicts === STUDENTS - 1 &&
  other.length === 0 &&
  touching.status === 201 &&
  replayed &&
  [...problemTypes].every((t) => t === "application/problem+json");
console.log(
  ok
    ? "PASS: one winner, no 5xx, problem+json losers, touching accepted, retry idempotent"
    : "FAIL",
);
process.exitCode = ok ? 0 : 1;
