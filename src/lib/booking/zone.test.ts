import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MS_PER_HOUR, MS_PER_MINUTE } from "./interval";
import {
  addDays,
  isValidTimeZone,
  localDateKey,
  localDayWindow,
  wallClockToUtc,
  zoneLabel,
  zoneOffsetMs,
} from "./zone";

const LAB = "America/Argentina/Buenos_Aires";
const DST_ZONE = "America/New_York";

describe("lab timezone", () => {
  it("is UTC-3 all year", () => {
    expect(zoneOffsetMs(Date.UTC(2026, 0, 15), LAB)).toBe(-3 * MS_PER_HOUR);
    expect(zoneOffsetMs(Date.UTC(2026, 6, 15), LAB)).toBe(-3 * MS_PER_HOUR);
    expect(zoneLabel(Date.UTC(2026, 6, 15), LAB)).toBe("GMT-3");
  });

  it("accepts the legacy alias and rejects nonsense", () => {
    expect(isValidTimeZone("America/Buenos_Aires")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  it("maps local Friday 14:00 to 17:00 UTC", () => {
    const wall = Date.UTC(2026, 10, 13, 14, 0);
    expect(wallClockToUtc(wall, LAB)).toBe(Date.UTC(2026, 10, 13, 17, 0));
  });
});

describe("daylight saving", () => {
  it("makes the spring-forward day 23 hours long", () => {
    const day = localDayWindow("2026-03-08", DST_ZONE);
    expect((day.end - day.start) / MS_PER_HOUR).toBe(23);
  });

  it("makes the fall-back day 25 hours long", () => {
    const day = localDayWindow("2026-11-01", DST_ZONE);
    expect((day.end - day.start) / MS_PER_HOUR).toBe(25);
  });

  it("resolves a repeated wall time to the earlier instant", () => {
    const wall = Date.UTC(2026, 10, 1, 1, 30);
    const first = wallClockToUtc(wall, DST_ZONE);
    expect(first).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it("moves a non-existent wall time to just after the gap", () => {
    const wall = Date.UTC(2026, 2, 8, 2, 30);
    const resolved = wallClockToUtc(wall, DST_ZONE);
    expect(resolved).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });

  it("keeps stored instants distinct across the fall-back hour (no hidden overlap)", () => {
    // Two one-hour reservations that both display as 01:00-02:00 local are still different instants.
    const firstHour = Date.UTC(2026, 10, 1, 5, 0);
    const secondHour = Date.UTC(2026, 10, 1, 6, 0);
    expect(secondHour - firstHour).toBe(MS_PER_HOUR);
    expect(zoneOffsetMs(firstHour, DST_ZONE)).not.toBe(zoneOffsetMs(secondHour, DST_ZONE));
  });
});

describe("local day windows", () => {
  const dateKey = fc
    .date({ min: new Date("2024-01-01"), max: new Date("2028-12-31"), noInvalidDate: true })
    .map((d) => d.toISOString().slice(0, 10));

  it("tile the timeline without gaps or overlaps in any zone", () => {
    fc.assert(
      fc.property(
        dateKey,
        fc.constantFrom(LAB, DST_ZONE, "Europe/London", "Asia/Kolkata"),
        (key, zone) => {
          const today = localDayWindow(key, zone);
          const tomorrow = localDayWindow(addDays(key, 1), zone);
          expect(today.end).toBe(tomorrow.start);
          expect(today.end).toBeGreaterThan(today.start);
        },
      ),
    );
  });

  it("contain the instants whose local date key matches", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2027, 0, 1) }),
        fc.constantFrom(LAB, DST_ZONE),
        (instant, zone) => {
          const window = localDayWindow(localDateKey(instant, zone), zone);
          expect(instant).toBeGreaterThanOrEqual(window.start);
          expect(instant).toBeLessThan(window.end);
        },
      ),
    );
  });

  it("rejects malformed date keys", () => {
    expect(() => localDayWindow("2026-3-8", LAB)).toThrow(RangeError);
  });

  it("starts local days on 15 minute boundaries so slots stay aligned", () => {
    const day = localDayWindow("2026-11-13", LAB);
    expect(day.start % (15 * MS_PER_MINUTE)).toBe(0);
  });
});

describe("the lab's own zone across a real offset change", () => {
  // Argentina observed DST until 2009-03-15 02:00Z, when UTC-2 fell back to UTC-3.
  it("changes offset exactly at the transition", () => {
    expect(zoneOffsetMs(Date.UTC(2009, 2, 15, 1, 59), LAB)).toBe(-2 * MS_PER_HOUR);
    expect(zoneOffsetMs(Date.UTC(2009, 2, 15, 2, 1), LAB)).toBe(-3 * MS_PER_HOUR);
  });

  it("makes the fall-back day 25 hours long and the next day start where it ends", () => {
    const day = localDayWindow("2009-03-14", LAB);
    expect((day.end - day.start) / MS_PER_HOUR).toBe(25);
    expect(localDayWindow("2009-03-15", LAB).start).toBe(day.end);
  });

  it("shows two different instants as the same wall-clock hour", () => {
    const first = Date.UTC(2009, 2, 15, 1, 0);
    const second = Date.UTC(2009, 2, 15, 2, 0);
    const wall = (instant: number) =>
      new Date(instant + zoneOffsetMs(instant, LAB)).toISOString().slice(11, 16);
    expect(wall(first)).toBe("23:00");
    expect(wall(second)).toBe("23:00");
  });
});
