/**
 * Half-open time intervals `[start, end)` over UTC instants (epoch milliseconds).
 * Pure functions only: no clock, no I/O.
 */

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

export interface Interval {
  /** Inclusive start, epoch milliseconds (UTC). */
  readonly start: number;
  /** Exclusive end, epoch milliseconds (UTC). */
  readonly end: number;
}

export function makeInterval(start: number, end: number): Interval {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new RangeError("interval bounds must be finite numbers");
  }
  if (end <= start) {
    throw new RangeError("interval end must be after start");
  }
  return { start, end };
}

export function durationMs(interval: Interval): number {
  return interval.end - interval.start;
}

/** True when the two half-open intervals share at least one instant. Touching endpoints do not overlap. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** True when `instant` lies in `[start, end)`. */
export function contains(interval: Interval, instant: number): boolean {
  return interval.start <= instant && instant < interval.end;
}

/** The range a booking blocks: the booked interval extended by the resource buffer. */
export function blockedRange(booked: Interval, bufferMinutes: number): Interval {
  if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0) {
    throw new RangeError("buffer must be a non-negative whole number of minutes");
  }
  return { start: booked.start, end: booked.end + bufferMinutes * MS_PER_MINUTE };
}

/** Sort by start then end; returns a new array. */
export function sortIntervals(intervals: readonly Interval[]): Interval[] {
  return [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Merge overlapping or touching intervals into a minimal sorted list. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const next of sortIntervals(intervals)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && next.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, next.end) };
    } else {
      merged.push(next);
    }
  }
  return merged;
}

/** Free gaps inside `window` that are not covered by any of `blocked`. */
export function freeGaps(window: Interval, blocked: readonly Interval[]): Interval[] {
  const gaps: Interval[] = [];
  let cursor = window.start;
  for (const block of mergeIntervals(blocked)) {
    if (block.end <= cursor) continue;
    if (block.start >= window.end) break;
    if (block.start > cursor) gaps.push({ start: cursor, end: block.start });
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < window.end) gaps.push({ start: cursor, end: window.end });
  return gaps;
}
