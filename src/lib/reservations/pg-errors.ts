/** SQLSTATE codes this module reacts to. */
export const SQLSTATE = {
  exclusionViolation: "23P01",
  serializationFailure: "40001",
  deadlockDetected: "40P01",
} as const;

/** The SQLSTATE of an error, looking through driver and ORM wrappers (`cause` chain). */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = current.cause;
  }
  return undefined;
}

export function isExclusionViolation(error: unknown): boolean {
  return pgErrorCode(error) === SQLSTATE.exclusionViolation;
}

/** Errors PostgreSQL asks the client to retry by re-running the whole transaction. */
export function isRetryable(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === SQLSTATE.serializationFailure || code === SQLSTATE.deadlockDetected;
}
