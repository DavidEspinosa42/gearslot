import { zoneLabel } from "../booking/zone";

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(
  key: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const id = `${key}|${timeZone}`;
  let found = cache.get(id);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-GB", { timeZone, ...options });
    cache.set(id, found);
  }
  return found;
}

/** 24-hour wall clock in the lab zone, for example `14:00`. */
export function formatClock(instant: number, timeZone: string): string {
  return formatter("clock", timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}

/** Short day label in the lab zone, for example `Fri 13 Nov`. */
export function formatDay(instant: number, timeZone: string): string {
  return formatter("day", timeZone, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(instant);
}

/** `Fri 13 Nov, 14:00-18:00 GMT-3`; the end gets its own day when the booking crosses midnight. */
export function formatRange(start: number, end: number, timeZone: string): string {
  const sameDay = formatDay(start, timeZone) === formatDay(end, timeZone);
  const endText = sameDay
    ? formatClock(end, timeZone)
    : `${formatDay(end, timeZone)} ${formatClock(end, timeZone)}`;
  return `${formatDay(start, timeZone)}, ${formatClock(start, timeZone)}–${endText} ${zoneLabel(start, timeZone)}`;
}

/** `1 h 30 min`, `45 min`, `2 h`. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
