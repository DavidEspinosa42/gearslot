import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { idempotencyRecords } from "../db/schema";

/** The transaction handle Drizzle passes to `db.transaction(...)`; nested calls create savepoints. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface KeyScope {
  readonly userId: string;
  readonly key: string;
}

export type Claim =
  | { readonly kind: "claimed" }
  | { readonly kind: "replay"; readonly statusCode: number; readonly response: unknown }
  | { readonly kind: "mismatch" };

/** Stable fingerprint of a request, so a reused key with a different body is detectable. */
export function hashRequest(operation: string, payload: Record<string, string | number>): string {
  const canonical = JSON.stringify([
    operation,
    Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Claims `(user, key)` inside the caller's transaction. The insert takes the unique-index slot, so a
 * concurrent duplicate blocks here until this transaction ends: it then sees the stored outcome (replay)
 * or, if this transaction rolled back, claims the key itself.
 */
export async function claimKey(
  tx: Tx,
  scope: KeyScope,
  operation: string,
  requestHash: string,
): Promise<Claim> {
  const inserted = await tx
    .insert(idempotencyRecords)
    .values({
      userId: scope.userId,
      key: scope.key,
      operation,
      requestHash,
      statusCode: 0,
      response: {},
    })
    .onConflictDoNothing()
    .returning({ key: idempotencyRecords.key });
  if (inserted.length > 0) return { kind: "claimed" };

  const [existing] = await tx
    .select()
    .from(idempotencyRecords)
    .where(and(eq(idempotencyRecords.userId, scope.userId), eq(idempotencyRecords.key, scope.key)));
  if (existing === undefined) {
    // The conflicting record was removed between the two statements (purge). Treat as unclaimable.
    throw new Error("idempotency record vanished during claim");
  }
  if (existing.requestHash !== requestHash) return { kind: "mismatch" };
  return { kind: "replay", statusCode: existing.statusCode, response: existing.response };
}

/** Records the outcome of a claimed key in the same transaction as the work it describes. */
export async function storeOutcome(
  tx: Tx,
  scope: KeyScope,
  statusCode: number,
  response: unknown,
): Promise<void> {
  await tx
    .update(idempotencyRecords)
    .set({ statusCode, response })
    .where(and(eq(idempotencyRecords.userId, scope.userId), eq(idempotencyRecords.key, scope.key)));
}
