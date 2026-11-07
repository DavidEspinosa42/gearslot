/**
 * Browser-side client for the JSON API. It never decides anything: it sends requests, classifies
 * answers, and keeps the Idempotency-Key stable across retries of one attempt.
 */
import type { Block } from "../booking/timeline";
import type { ReservationDto, Suggestions } from "../reservations/result";
import type { BlockDto, LabDto, ResourceDto } from "../reservations/service";

export type { LabDto, ReservationDto, ResourceDto, Suggestions };

export interface Problem {
  readonly code: string;
  readonly title: string;
  readonly status: number;
  readonly suggestions?: Suggestions;
  readonly limit?: number;
  readonly category?: string;
}

export type Outcome<T> =
  | { readonly kind: "ok"; readonly status: number; readonly data: T; readonly replayed: boolean }
  | { readonly kind: "problem"; readonly status: number; readonly problem: Problem }
  | { readonly kind: "unauthorized" }
  /** No answer: offline, timed out, or the connection dropped. The request may or may not have landed. */
  | { readonly kind: "network" };

type Fetch = typeof fetch;
const TIMEOUT_MS = 15_000;

async function call<T>(
  fetchImpl: Fetch,
  path: string,
  init: RequestInit = {},
): Promise<Outcome<T>> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { kind: "network" };
  }
  if (response.status === 401) return { kind: "unauthorized" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A proxy error page or a cut-off body: treat as no usable answer.
    return response.ok ? { kind: "network" } : problemOf(response.status, {});
  }
  if (response.ok) {
    return {
      kind: "ok",
      status: response.status,
      data: body as T,
      replayed: response.headers.get("idempotent-replayed") === "true",
    };
  }
  return problemOf(response.status, body);
}

function problemOf(status: number, body: unknown): Outcome<never> {
  const record = (typeof body === "object" && body !== null ? body : {}) as Partial<Problem>;
  return {
    kind: "problem",
    status,
    problem: {
      ...record,
      code: record.code ?? "unknown",
      title: record.title ?? "Request failed",
      status,
    },
  };
}

/** One attempt at a write. Keep the same attempt for retries after `network` or 5xx answers. */
export interface Attempt {
  readonly key: string;
}

export function newAttempt(): Attempt {
  return { key: crypto.randomUUID() };
}

/**
 * Whether the attempt is over. A definitive answer (success, conflict, rule violation) closes it;
 * silence or a server error leaves the outcome unknown, so the retry must reuse the key and let the
 * server replay whatever it already decided.
 */
export function attemptIsFinished(outcome: Outcome<unknown>): boolean {
  if (outcome.kind === "ok") return true;
  if (outcome.kind === "problem") return outcome.status < 500;
  return false;
}

export function createApi(fetchImpl: Fetch = (...args) => fetch(...args)) {
  const post = (key: string, body?: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return {
    lab: () => call<{ lab: LabDto; resources: ResourceDto[] }>(fetchImpl, "/api/resources"),

    availability: async (
      resourceId: string,
      from: number,
      to: number,
    ): Promise<Outcome<Block[]>> => {
      const query = new URLSearchParams({
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      });
      const outcome = await call<{ blocks: BlockDto[] }>(
        fetchImpl,
        `/api/resources/${resourceId}/availability?${query}`,
      );
      if (outcome.kind !== "ok") return outcome;
      return {
        ...outcome,
        data: outcome.data.blocks.map((b) => ({
          start: Date.parse(b.startsAt),
          end: Date.parse(b.blockedUntil),
          mine: b.mine,
        })),
      };
    },

    mine: () => call<{ reservations: ReservationDto[] }>(fetchImpl, "/api/reservations"),

    book: (attempt: Attempt, resourceId: string, startsAt: number, endsAt: number) =>
      call<{ reservation: ReservationDto }>(
        fetchImpl,
        "/api/reservations",
        post(attempt.key, {
          resourceId,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
        }),
      ),

    cancel: (attempt: Attempt, reservationId: string) =>
      call<{ reservation: ReservationDto }>(
        fetchImpl,
        `/api/reservations/${reservationId}/cancel`,
        post(attempt.key),
      ),
  };
}

export type Api = ReturnType<typeof createApi>;
