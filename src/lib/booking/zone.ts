/**
 * Lab-local time helpers built on the platform `Intl` API.
 * Storage is always UTC instants; these functions exist only for display
 * and for turning a local calendar day into a UTC window.
 */

import { type Interval, MS_PER_DAY } from "./interval";

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** True when `timeZone` is a zone name the runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (east is positive). */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  const fields: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(whole)) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    fields["year"] ?? 1970,
    (fields["month"] ?? 1) - 1,
    fields["day"] ?? 1,
    fields["hour"] ?? 0,
    fields["minute"] ?? 0,
    fields["second"] ?? 0,
  );
  return asUtc - whole;
}

/**
 * The UTC instant for a wall-clock time in `timeZone`, where `wallAsUtc` is the wall-clock
 * reading expressed as if it were UTC. An ambiguous time (clocks go back) resolves to the earlier
 * instant; a time that does not exist (clocks go forward) resolves to the instant just after the gap.
 */
export function wallClockToUtc(wallAsUtc: number, timeZone: string): number {
  const candidates = new Set<number>();
  for (const probe of [wallAsUtc - MS_PER_DAY, wallAsUtc + MS_PER_DAY]) {
    const offset = zoneOffsetMs(probe, timeZone);
    const instant = wallAsUtc - offset;
    if (zoneOffsetMs(instant, timeZone) === offset) candidates.add(instant);
  }
  if (candidates.size > 0) return Math.min(...candidates);
  // Inside a gap: use the offset in force before the gap, which lands just after it.
  return wallAsUtc - zoneOffsetMs(wallAsUtc - MS_PER_DAY, timeZone);
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The local calendar day `YYYY-MM-DD` as a UTC window (23, 24 or 25 hours long). */
export function localDayWindow(dateKey: string, timeZone: string): Interval {
  const match = DATE_KEY.exec(dateKey);
  if (match === null) throw new RangeError(`invalid date key: ${dateKey}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const start = wallClockToUtc(Date.UTC(year, month - 1, day), timeZone);
  const nextDay = Date.UTC(year, month - 1, day + 1);
  const end = wallClockToUtc(nextDay, timeZone);
  return { start, end };
}

/** The local calendar day containing `instant`, as `YYYY-MM-DD`. */
export function localDateKey(instant: number, timeZone: string): string {
  const offset = zoneOffsetMs(instant, timeZone);
  return new Date(instant + offset).toISOString().slice(0, 10);
}

/** Adds `days` to a `YYYY-MM-DD` key (calendar arithmetic, no time zone involved). */
export function addDays(dateKey: string, days: number): string {
  const match = DATE_KEY.exec(dateKey);
  if (match === null) throw new RangeError(`invalid date key: ${dateKey}`);
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(base + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Short zone label at `instant`, for example `GMT-3`. */
export function zoneLabel(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName");
  return parts?.value ?? timeZone;
}
