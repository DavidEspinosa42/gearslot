import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { loadSettings } from "./service";

/** Idempotency records only need to outlive realistic client retries. */
export const IDEMPOTENCY_RETENTION_DAYS = 7;

export interface PurgeReport {
  readonly reservations: number;
  readonly idempotencyRecords: number;
  readonly users: number;
}

/**
 * Data-policy retention: reservation history that ended more than `retention_months` ago is deleted
 * (cancelled rows included), expired idempotency records go, and people with no remaining
 * reservations are dropped so nothing about them lingers. Everything runs in one transaction.
 */
export async function purgeHistory(db: Database, now: Date): Promise<PurgeReport> {
  return db.transaction(async (tx) => {
    const settings = await loadSettings(tx);
    const reservationCutoff = sql`${now.toISOString()}::timestamptz - make_interval(months => ${settings.retentionMonths})`;
    const recordCutoff = sql`${now.toISOString()}::timestamptz - make_interval(days => ${IDEMPOTENCY_RETENTION_DAYS})`;

    const reservations = await tx.execute(
      sql`DELETE FROM reservations WHERE ends_at < ${reservationCutoff}`,
    );
    const idempotencyRecords = await tx.execute(
      sql`DELETE FROM idempotency_records WHERE created_at < ${recordCutoff}`,
    );
    const users = await tx.execute(
      sql`DELETE FROM users u WHERE NOT EXISTS (SELECT 1 FROM reservations r WHERE r.user_id = u.id)`,
    );
    return {
      reservations: reservations.rowCount ?? 0,
      idempotencyRecords: idempotencyRecords.rowCount ?? 0,
      users: users.rowCount ?? 0,
    };
  });
}
