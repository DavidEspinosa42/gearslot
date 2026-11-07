import { and, asc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { type Interval, MS_PER_DAY, MS_PER_MINUTE } from "../booking/interval";
import { type BookingRules, isQuotaReached, validateBooking } from "../booking/rules";
import { freeIdenticalUnits, nextFreeSlots } from "../booking/suggestions";
import type { Database } from "../db/client";
import {
  categories,
  type LabSettings,
  labSettings,
  type Reservation,
  type Resource,
  reservations,
  resources,
  users,
} from "../db/schema";
import { claimKey, hashRequest, type KeyScope, storeOutcome, type Tx } from "./idempotency";
import { isExclusionViolation, isRetryable } from "./pg-errors";
import {
  type ProblemCode,
  problem,
  type ReservationDto,
  type ServiceResult,
  type Suggestions,
} from "./result";

export interface Actor {
  /** Opaque SSO subject. */
  readonly userId: string;
  readonly displayName: string;
}

const SUGGESTION_SLOTS = 3;
const MAX_ATTEMPTS = 5;

export function rulesFrom(settings: LabSettings): BookingRules {
  return {
    slotMinutes: settings.slotMinutes,
    minMinutes: settings.minMinutes,
    maxMinutes: settings.maxMinutes,
    horizonDays: settings.horizonDays,
  };
}

export async function loadSettings(tx: Pick<Database, "select">): Promise<LabSettings> {
  const [settings] = await tx.select().from(labSettings);
  if (settings === undefined) throw new Error("lab_settings row is missing (run migrations)");
  return settings;
}

function toDto(row: Reservation, resourceName: string): ReservationDto {
  return {
    id: row.id,
    resourceId: row.resourceId,
    resourceName,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    blockedUntil: row.blockedUntil.toISOString(),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Re-runs a whole transaction when PostgreSQL reports a deadlock or serialization failure. */
async function withRetry<T>(run: () => Promise<T>): Promise<T | undefined> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS) {
        if (isRetryable(error)) return undefined;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * attempt));
    }
  }
  return undefined;
}

function busy(): ServiceResult {
  const { status, body } = problem(503, "busy", "The server is busy, please retry.");
  return { status, body, replayed: false };
}

/**
 * Locks reservation rows for update in ascending id order. Every operation that touches several
 * reservations (reschedule, swap) must go through here so two of them can never wait on each other.
 */
export async function lockReservationsInOrder(
  tx: Tx,
  ids: readonly string[],
): Promise<Reservation[]> {
  if (ids.length === 0) return [];
  const sorted = [...new Set(ids)].sort();
  return tx
    .select()
    .from(reservations)
    .where(inArray(reservations.id, sorted))
    .orderBy(asc(reservations.id))
    .for("update");
}

async function loadBlocked(
  tx: Tx,
  resourceIds: readonly string[],
  from: Date,
): Promise<Map<string, Interval[]>> {
  const blocked = new Map<string, Interval[]>(resourceIds.map((id) => [id, []]));
  if (resourceIds.length === 0) return blocked;
  const rows = await tx
    .select({
      resourceId: reservations.resourceId,
      startsAt: reservations.startsAt,
      blockedUntil: reservations.blockedUntil,
    })
    .from(reservations)
    .where(
      and(
        inArray(reservations.resourceId, [...resourceIds]),
        eq(reservations.status, "active"),
        gt(reservations.blockedUntil, from),
      ),
    );
  for (const row of rows) {
    blocked
      .get(row.resourceId)
      ?.push({ start: row.startsAt.getTime(), end: row.blockedUntil.getTime() });
  }
  return blocked;
}

async function buildSuggestions(
  tx: Tx,
  resource: Resource,
  request: Interval,
  now: Date,
  rules: BookingRules,
): Promise<Suggestions> {
  const siblings = await tx
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.model, resource.model),
        eq(resources.active, true),
        ne(resources.id, resource.id),
      ),
    )
    .orderBy(asc(resources.name));
  const blocked = await loadBlocked(tx, [resource.id, ...siblings.map((s) => s.id)], now);

  const identical = freeIdenticalUnits(
    request,
    siblings.map((s) => ({
      id: s.id,
      name: s.name,
      bufferMinutes: s.bufferMinutes,
      blocked: blocked.get(s.id) ?? [],
    })),
  );
  const slots = nextFreeSlots({
    request,
    blocked: blocked.get(resource.id) ?? [],
    bufferMinutes: resource.bufferMinutes,
    now: now.getTime(),
    rules,
    limit: SUGGESTION_SLOTS,
  });
  return {
    identicalUnits: identical.map((unit) => ({ resourceId: unit.id, name: unit.name })),
    nextSlots: slots.map((slot) => ({
      startsAt: new Date(slot.start).toISOString(),
      endsAt: new Date(slot.end).toISOString(),
    })),
  };
}

export interface CreateInput {
  readonly actor: Actor;
  readonly idempotencyKey: string;
  readonly resourceId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** The clock, injected so tests and callers control "now". */
  readonly now: Date;
}

/**
 * Books one resource over `[startsAt, endsAt)`.
 * The database decides whether the slot is free: the insert either succeeds or raises SQLSTATE 23P01
 * from the exclusion constraint, which becomes a 409 with suggestions. See docs/adr/0001 and 0003.
 */
export async function createReservation(db: Database, input: CreateInput): Promise<ServiceResult> {
  const scope: KeyScope = { userId: input.actor.userId, key: input.idempotencyKey };
  const requestHash = hashRequest("create", {
    resourceId: input.resourceId,
    startsAt: input.startsAt.getTime(),
    endsAt: input.endsAt.getTime(),
  });

  const result = await withRetry(() =>
    db.transaction(async (tx): Promise<ServiceResult> => {
      const claim = await claimKey(tx, scope, "create", requestHash);
      if (claim.kind === "replay") {
        return {
          status: claim.statusCode,
          body: claim.response as Record<string, unknown>,
          replayed: true,
        };
      }
      if (claim.kind === "mismatch") {
        const { status, body } = problem(
          422,
          "idempotency_mismatch",
          "This Idempotency-Key was already used for a different request.",
        );
        return { status, body, replayed: false };
      }

      const outcome = await attemptCreate(tx, input);
      await storeOutcome(tx, scope, outcome.status, outcome.body);
      return { ...outcome, replayed: false };
    }),
  );
  return result ?? busy();
}

async function attemptCreate(
  tx: Tx,
  input: CreateInput,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { actor, now } = input;

  await tx
    .insert(users)
    .values({ id: actor.userId, displayName: actor.displayName })
    .onConflictDoUpdate({
      target: users.id,
      set: { displayName: actor.displayName },
      setWhere: sql`${users.displayName} IS DISTINCT FROM excluded.display_name`,
    });

  const settings = await loadSettings(tx);
  const rules = rulesFrom(settings);

  const [resource] = await tx
    .select()
    .from(resources)
    .where(and(eq(resources.id, input.resourceId), eq(resources.active, true)));
  if (resource === undefined) return problem(404, "resource_not_found", "No such item.");

  // The idempotency record may have been purged (7 days) while the reservation it created lives on
  // and still owns this key. Reconcile with it instead of tripping reservations_user_key_unique.
  const [keyed] = await tx
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.userId, actor.userId),
        eq(reservations.idempotencyKey, input.idempotencyKey),
      ),
    );
  if (keyed !== undefined) {
    const same =
      keyed.resourceId === input.resourceId &&
      keyed.startsAt.getTime() === input.startsAt.getTime() &&
      keyed.endsAt.getTime() === input.endsAt.getTime();
    if (!same) {
      return problem(
        422,
        "idempotency_mismatch",
        "This Idempotency-Key was already used for a different request.",
      );
    }
    return { status: 201, body: { reservation: toDto(keyed, resource.name) } };
  }

  const request: Interval = { start: input.startsAt.getTime(), end: input.endsAt.getTime() };
  const violations = validateBooking(request, now.getTime(), rules);
  const first = violations[0];
  if (first !== undefined) {
    return problem(422, first.code as ProblemCode, first.message, {
      violations: violations.map((v) => ({ code: v.code, message: v.message })),
    });
  }

  // Serialise this user's bookings per category so the cap cannot be beaten by parallel requests.
  const [category] = await tx
    .select()
    .from(categories)
    .where(eq(categories.id, resource.categoryId));
  if (category === undefined) throw new Error(`category ${resource.categoryId} is missing`);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.userId}:${category.id}`}, 0))`,
  );
  const [held] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(reservations)
    .innerJoin(resources, eq(reservations.resourceId, resources.id))
    .where(
      and(
        eq(reservations.userId, actor.userId),
        eq(reservations.status, "active"),
        eq(resources.categoryId, category.id),
        gt(reservations.endsAt, now),
      ),
    );
  if (isQuotaReached(held?.count ?? 0, category.maxActivePerUser)) {
    return problem(
      409,
      "quota_exceeded",
      `You already hold ${category.maxActivePerUser} active ${category.name.toLowerCase()} reservations.`,
      { category: category.id, limit: category.maxActivePerUser },
    );
  }

  // Queue racers for the same resource. Without this, two conflicting inserts each wait on the
  // other's uncommitted row and PostgreSQL resolves it as a deadlock (about 1 s per detection).
  // Lock order is always: idempotency row, user row, user+category lock, resource lock.
  // The exclusion constraint, not this lock, is what forbids the overlap.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${resource.id}, 0))`);

  const blockedUntil = new Date(input.endsAt.getTime() + resource.bufferMinutes * MS_PER_MINUTE);
  try {
    // The savepoint lets us roll back a 23P01 and still commit the stored 409 outcome.
    const [row] = await tx.transaction(async (savepoint) =>
      savepoint
        .insert(reservations)
        .values({
          resourceId: resource.id,
          userId: actor.userId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          blockedUntil,
          idempotencyKey: input.idempotencyKey,
        })
        .returning(),
    );
    if (row === undefined) throw new Error("insert returned no row");
    return { status: 201, body: { reservation: toDto(row, resource.name) } };
  } catch (error) {
    if (!isExclusionViolation(error)) throw error;
    const suggestions = await buildSuggestions(tx, resource, request, now, rules);
    return problem(409, "conflict", "That time is no longer available.", { suggestions });
  }
}

export interface CancelInput {
  readonly actor: Actor;
  readonly idempotencyKey: string;
  readonly reservationId: string;
  readonly now: Date;
}

/** Cancels the caller's reservation. Status change only; the row is kept for audit. */
export async function cancelReservation(db: Database, input: CancelInput): Promise<ServiceResult> {
  const scope: KeyScope = { userId: input.actor.userId, key: input.idempotencyKey };
  const requestHash = hashRequest("cancel", { reservationId: input.reservationId });

  const result = await withRetry(() =>
    db.transaction(async (tx): Promise<ServiceResult> => {
      const claim = await claimKey(tx, scope, "cancel", requestHash);
      if (claim.kind === "replay") {
        return {
          status: claim.statusCode,
          body: claim.response as Record<string, unknown>,
          replayed: true,
        };
      }
      if (claim.kind === "mismatch") {
        const { status, body } = problem(
          422,
          "idempotency_mismatch",
          "This Idempotency-Key was already used for a different request.",
        );
        return { status, body, replayed: false };
      }

      const outcome = await attemptCancel(tx, input);
      await storeOutcome(tx, scope, outcome.status, outcome.body);
      return { ...outcome, replayed: false };
    }),
  );
  return result ?? busy();
}

async function attemptCancel(
  tx: Tx,
  input: CancelInput,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const [row] = await lockReservationsInOrder(tx, [input.reservationId]);
  // Another person's reservation looks exactly like a missing one.
  if (row === undefined || row.userId !== input.actor.userId) {
    return problem(404, "reservation_not_found", "No such reservation.");
  }
  const [resource] = await tx.select().from(resources).where(eq(resources.id, row.resourceId));
  const name = resource?.name ?? "";
  if (row.status === "cancelled") {
    return problem(409, "already_cancelled", "This reservation was already cancelled.");
  }
  if (row.endsAt.getTime() <= input.now.getTime()) {
    return problem(409, "already_ended", "This reservation has already ended.");
  }
  const [updated] = await tx
    .update(reservations)
    .set({ status: "cancelled", cancelledAt: input.now })
    .where(eq(reservations.id, row.id))
    .returning();
  if (updated === undefined) throw new Error("cancel returned no row");
  return { status: 200, body: { reservation: toDto(updated, name) } };
}

/** The caller's active, not yet finished reservations, soonest first. */
export async function listMyReservations(
  db: Database,
  userId: string,
  now: Date,
): Promise<ReservationDto[]> {
  const rows = await db
    .select({ reservation: reservations, resourceName: resources.name })
    .from(reservations)
    .innerJoin(resources, eq(reservations.resourceId, resources.id))
    .where(
      and(
        eq(reservations.userId, userId),
        eq(reservations.status, "active"),
        gt(reservations.endsAt, now),
      ),
    )
    .orderBy(asc(reservations.startsAt));
  return rows.map((row) => toDto(row.reservation, row.resourceName));
}

export interface LabDto {
  readonly timezone: string;
  readonly slotMinutes: number;
  readonly minMinutes: number;
  readonly maxMinutes: number;
  readonly horizonDays: number;
}

/** The per-instance rules the client needs to render the timeline and validate inputs early. */
export async function getLab(db: Database): Promise<LabDto> {
  const settings = await loadSettings(db);
  return {
    timezone: settings.timezone,
    slotMinutes: settings.slotMinutes,
    minMinutes: settings.minMinutes,
    maxMinutes: settings.maxMinutes,
    horizonDays: settings.horizonDays,
  };
}

export interface ResourceDto {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly locationLabel: string;
  readonly bufferMinutes: number;
}

export async function listResources(db: Database): Promise<ResourceDto[]> {
  const rows = await db
    .select({
      id: resources.id,
      name: resources.name,
      model: resources.model,
      categoryId: resources.categoryId,
      categoryName: categories.name,
      locationLabel: resources.locationLabel,
      bufferMinutes: resources.bufferMinutes,
    })
    .from(resources)
    .innerJoin(categories, eq(resources.categoryId, categories.id))
    .where(eq(resources.active, true))
    .orderBy(asc(categories.name), asc(resources.name));
  return rows;
}

export interface BlockDto {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly blockedUntil: string;
  /** True when the caller owns it. Other people are never identified. */
  readonly mine: boolean;
}

/** Taken blocks of one resource that touch `[from, to)`, buffer included, with no other user's identity. */
export async function getAvailability(
  db: Database,
  resourceId: string,
  window: { from: Date; to: Date },
  userId: string,
): Promise<BlockDto[] | undefined> {
  const [resource] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.id, resourceId), eq(resources.active, true)));
  if (resource === undefined) return undefined;
  const rows = await db
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.resourceId, resourceId),
        eq(reservations.status, "active"),
        lt(reservations.startsAt, window.to),
        gt(reservations.blockedUntil, window.from),
      ),
    )
    .orderBy(asc(reservations.startsAt));
  return rows.map((row) => ({
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    blockedUntil: row.blockedUntil.toISOString(),
    mine: row.userId === userId,
  }));
}

/** Longest window the availability query accepts, in days. */
export const MAX_AVAILABILITY_DAYS = 35;
export const MAX_AVAILABILITY_MS = MAX_AVAILABILITY_DAYS * MS_PER_DAY;
