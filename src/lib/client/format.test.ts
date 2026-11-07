import { describe, expect, it } from "vitest";
import { formatClock, formatDay, formatDuration, formatRange } from "./format";

const LAB = "America/Argentina/Buenos_Aires";

describe("lab-local formatting", () => {
  it("shows UTC instants in Buenos Aires time", () => {
    const start = Date.parse("2026-11-13T17:00:00Z");
    expect(formatClock(start, LAB)).toBe("14:00");
    expect(formatDay(start, LAB)).toBe("Fri 13 Nov");
  });

  it("always labels the zone", () => {
    const text = formatRange(
      Date.parse("2026-11-13T17:00:00Z"),
      Date.parse("2026-11-13T21:00:00Z"),
      LAB,
    );
    expect(text).toBe("Fri 13 Nov, 14:00–18:00 GMT-3");
  });

  it("names the end day when a booking crosses local midnight", () => {
    const text = formatRange(
      Date.parse("2026-11-13T23:00:00Z"),
      Date.parse("2026-11-14T05:00:00Z"),
      LAB,
    );
    expect(text).toContain("20:00–Sat 14 Nov 02:00");
  });

  it("follows DST in zones that have it", () => {
    expect(formatClock(Date.parse("2026-07-01T16:00:00Z"), "America/New_York")).toBe("12:00");
    expect(formatClock(Date.parse("2026-12-01T16:00:00Z"), "America/New_York")).toBe("11:00");
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 h");
    expect(formatDuration(90)).toBe("1 h 30 min");
  });
});
