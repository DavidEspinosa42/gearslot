import {
  blockedRange,
  freeGaps,
  type Interval,
  MS_PER_DAY,
  MS_PER_MINUTE,
  overlaps,
} from "./interval";
import { type BookingRules, ceilToSlot, validateBooking } from "./rules";

/** A resource that could stand in for the requested one. */
export interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly bufferMinutes: number;
  /** Blocked ranges of its active reservations (buffers already included). */
  readonly blocked: readonly Interval[];
}

/**
 * Interchangeable units (same model) that are free for exactly the requested interval.
 * Order of `candidates` is preserved so results are deterministic.
 */
export function freeIdenticalUnits(
  request: Interval,
  candidates: readonly Candidate[],
): Candidate[] {
  return candidates.filter((candidate) => {
    const needed = blockedRange(request, candidate.bufferMinutes);
    return !candidate.blocked.some((block) => overlaps(needed, block));
  });
}

/**
 * The next start times, on the slot grid, at which a booking of the same length fits on one
 * resource. The booking's own buffer must fit too. At most one suggestion per free gap, earliest
 * first, never before the requested start or `now`, and never past the booking horizon.
 */
export function nextFreeSlots(params: {
  request: Interval;
  blocked: readonly Interval[];
  bufferMinutes: number;
  now: number;
  rules: BookingRules;
  limit: number;
}): Interval[] {
  const { request, blocked, bufferMinutes, now, rules, limit } = params;
  const length = request.end - request.start;
  const needed = length + bufferMinutes * MS_PER_MINUTE;
  const windowStart = ceilToSlot(Math.max(request.start, now), rules);
  const windowEnd = now + rules.horizonDays * MS_PER_DAY + bufferMinutes * MS_PER_MINUTE;
  if (windowEnd <= windowStart || limit <= 0) return [];

  const suggestions: Interval[] = [];
  for (const gap of freeGaps({ start: windowStart, end: windowEnd }, blocked)) {
    const start = ceilToSlot(gap.start, rules);
    if (start + needed > gap.end) continue;
    const candidate: Interval = { start, end: start + length };
    if (validateBooking(candidate, now, rules).length > 0) continue;
    suggestions.push(candidate);
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}
