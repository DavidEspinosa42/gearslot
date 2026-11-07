import { addDays, localDateKey, wallClockToUtc } from "../../src/lib/booking/zone";

/** The next local Friday after today in `timezone`, and a helper for its local hours as UTC dates. */
export function nextFriday(timezone: string, nowMs: number = Date.now()) {
  const today = localDateKey(nowMs, timezone);
  const [y = 1970, m = 1, d = 1] = today.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const key = addDays(today, (5 - weekday + 7) % 7 || 7);
  const [fy = 1970, fm = 1, fd = 1] = key.split("-").map(Number);
  return {
    key,
    at: (hour: number): Date => new Date(wallClockToUtc(Date.UTC(fy, fm - 1, fd, hour), timezone)),
  };
}
