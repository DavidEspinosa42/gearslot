/** Outcome of a write: an HTTP-shaped status and a JSON body, replayable from storage. */
export interface ServiceResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** True when the body came from a stored idempotent outcome instead of new work. */
  readonly replayed: boolean;
}

export type ProblemCode =
  | "conflict"
  | "quota_exceeded"
  | "invalid_range"
  | "not_aligned"
  | "too_short"
  | "too_long"
  | "in_past"
  | "beyond_horizon"
  | "resource_not_found"
  | "reservation_not_found"
  | "already_cancelled"
  | "already_ended"
  | "idempotency_mismatch"
  | "unauthorized"
  | "invalid_request"
  | "missing_idempotency_key"
  | "invalid_window"
  | "busy"
  | "internal";

/** RFC 9457 problem body with a stable machine-readable `code`. */
export function problem(
  status: number,
  code: ProblemCode,
  title: string,
  extra: Record<string, unknown> = {},
): { status: number; body: Record<string, unknown> } {
  return {
    status,
    body: { type: `https://loan-loop.dev/problems/${code}`, title, status, code, ...extra },
  };
}

export interface ReservationDto {
  readonly id: string;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly blockedUntil: string;
  readonly status: "active" | "cancelled";
  readonly createdAt: string;
}

export interface Suggestions {
  readonly identicalUnits: readonly { resourceId: string; name: string }[];
  readonly nextSlots: readonly { startsAt: string; endsAt: string }[];
}
