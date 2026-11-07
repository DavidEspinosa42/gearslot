import { blockedRange, type Interval, MS_PER_DAY, MS_PER_MINUTE, overlaps } from "./interval";
import { type BookingRules, ceilToSlot, slotMs } from "./rules";

/** A taken range as the availability endpoint reports it: buffer included. */
export interface Block extends Interval {
  readonly mine: boolean;
}

export type SlotState = "free" | "taken" | "mine" | "past" | "beyond";

/** The grid slots that fit entirely inside one local day window (23-25 hours around a DST shift). */
export function daySlots(day: Interval, rules: BookingRules): Interval[] {
  const size = slotMs(rules);
  const slots: Interval[] = [];
  for (let start = ceilToSlot(day.start, rules); start + size <= day.end; start += size) {
    slots.push({ start, end: start + size });
  }
  return slots;
}

/** Why a single slot can or cannot be picked as a starting point, for display. */
export function slotState(
  slot: Interval,
  blocks: readonly Block[],
  now: number,
  rules: BookingRules,
): SlotState {
  const hit = blocks.find((block) => overlaps(slot, block));
  if (hit !== undefined) return hit.mine ? "mine" : "taken";
  if (slot.start < now) return "past";
  if (slot.end > now + rules.horizonDays * MS_PER_DAY) return "beyond";
  return "free";
}

/**
 * The longest booking, in minutes, that can start at `start` on a resource with `bufferMinutes`:
 * limited by the next taken block (the booking's own buffer must fit before it), the maximum length,
 * the booking horizon, and the shortest allowed length. 0 means nothing can start here.
 */
export function maxBookableMinutes(
  start: number,
  blocks: readonly Block[],
  bufferMinutes: number,
  now: number,
  rules: BookingRules,
): number {
  if (start < now || start % slotMs(rules) !== 0) return 0;
  const probe: Interval = { start, end: start + slotMs(rules) };
  if (blocks.some((block) => overlaps(blockedRange(probe, bufferMinutes), block))) return 0;

  const nextBlock = Math.min(
    Number.POSITIVE_INFINITY,
    ...blocks.filter((block) => block.end > start && block.start > start).map((b) => b.start),
  );
  const horizonEnd = now + rules.horizonDays * MS_PER_DAY;
  const latestEnd = Math.min(horizonEnd, nextBlock - bufferMinutes * MS_PER_MINUTE);
  const room = Math.min((latestEnd - start) / MS_PER_MINUTE, rules.maxMinutes);
  const minutes = Math.floor(room / rules.slotMinutes) * rules.slotMinutes;
  return minutes >= rules.minMinutes ? minutes : 0;
}

/**
 * The length a new selection starts with: `preferred` minutes, rounded down to the slot grid and
 * lifted to the shortest allowed length, never more than the `fits` the timeline offered.
 */
export function initialMinutes(fits: number, rules: BookingRules, preferred = 60): number {
  const grid = rules.slotMinutes;
  const wanted = Math.floor(Math.min(preferred, fits) / grid) * grid;
  const shortest = Math.ceil(rules.minMinutes / grid) * grid;
  return Math.min(fits, Math.max(wanted, shortest));
}

/** Quick-pick lengths that respect the grid, the minimum, and the room actually available. */
export function durationPresets(
  room: number,
  rules: BookingRules,
  candidates: readonly number[] = [30, 60, 120, 240],
): number[] {
  return candidates.filter(
    (m) =>
      m >= rules.minMinutes && m <= Math.min(room, rules.maxMinutes) && m % rules.slotMinutes === 0,
  );
}
