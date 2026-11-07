import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  blockedRange,
  freeGaps,
  type Interval,
  makeInterval,
  mergeIntervals,
  overlaps,
} from "./interval";

const instant = fc.integer({ min: 0, max: 10_000 });
const interval = fc
  .tuple(instant, fc.integer({ min: 1, max: 500 }))
  .map(([start, length]): Interval => ({ start, end: start + length }));

describe("overlaps", () => {
  it("treats touching endpoints as non-overlapping", () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
    expect(overlaps({ start: 10, end: 20 }, { start: 0, end: 10 })).toBe(false);
  });

  it("detects a single shared instant", () => {
    expect(overlaps({ start: 0, end: 11 }, { start: 10, end: 20 })).toBe(true);
  });

  it("is symmetric", () => {
    fc.assert(fc.property(interval, interval, (a, b) => overlaps(a, b) === overlaps(b, a)));
  });

  it("is reflexive for every valid interval", () => {
    fc.assert(fc.property(interval, (a) => overlaps(a, a)));
  });

  it("agrees with a brute-force check over discrete instants", () => {
    fc.assert(
      fc.property(interval, interval, (a, b) => {
        let shared = false;
        for (let t = Math.min(a.start, b.start); t < Math.max(a.end, b.end); t += 1) {
          if (a.start <= t && t < a.end && b.start <= t && t < b.end) shared = true;
        }
        return overlaps(a, b) === shared;
      }),
      { numRuns: 200 },
    );
  });
});

describe("makeInterval", () => {
  it("rejects empty and reversed ranges", () => {
    expect(() => makeInterval(5, 5)).toThrow(RangeError);
    expect(() => makeInterval(6, 5)).toThrow(RangeError);
  });
});

describe("blockedRange", () => {
  it("extends only the end by the buffer", () => {
    expect(blockedRange({ start: 0, end: 60_000 }, 30)).toEqual({
      start: 0,
      end: 60_000 + 30 * 60_000,
    });
  });

  it("makes a request that ends inside the buffer conflict", () => {
    const job = blockedRange({ start: 0, end: 120 * 60_000 }, 30);
    const afterBuffer = blockedRange({ start: 150 * 60_000, end: 180 * 60_000 }, 30);
    const insideBuffer = blockedRange({ start: 135 * 60_000, end: 180 * 60_000 }, 30);
    expect(overlaps(job, afterBuffer)).toBe(false);
    expect(overlaps(job, insideBuffer)).toBe(true);
  });

  it("rejects negative or fractional buffers", () => {
    expect(() => blockedRange({ start: 0, end: 1 }, -1)).toThrow(RangeError);
    expect(() => blockedRange({ start: 0, end: 1 }, 1.5)).toThrow(RangeError);
  });
});

describe("mergeIntervals", () => {
  it("returns sorted, pairwise non-touching intervals", () => {
    fc.assert(
      fc.property(fc.array(interval, { maxLength: 12 }), (list) => {
        const merged = mergeIntervals(list);
        for (let i = 1; i < merged.length; i += 1) {
          expect((merged[i] as Interval).start).toBeGreaterThan((merged[i - 1] as Interval).end);
        }
      }),
    );
  });

  it("covers exactly the same instants as its input", () => {
    fc.assert(
      fc.property(
        fc.array(interval, { maxLength: 8 }),
        fc.integer({ min: 0, max: 10_600 }),
        (list, t) => {
          const covered = (items: readonly Interval[]) =>
            items.some((i) => i.start <= t && t < i.end);
          return covered(list) === covered(mergeIntervals(list));
        },
      ),
    );
  });
});

describe("freeGaps", () => {
  it("never overlaps a blocked interval and stays inside the window", () => {
    fc.assert(
      fc.property(interval, fc.array(interval, { maxLength: 10 }), (window, blocked) => {
        for (const gap of freeGaps(window, blocked)) {
          expect(gap.start).toBeGreaterThanOrEqual(window.start);
          expect(gap.end).toBeLessThanOrEqual(window.end);
          expect(gap.end).toBeGreaterThan(gap.start);
          for (const b of blocked) expect(overlaps(gap, b)).toBe(false);
        }
      }),
    );
  });

  it("returns the whole window when nothing is blocked", () => {
    expect(freeGaps({ start: 0, end: 100 }, [])).toEqual([{ start: 0, end: 100 }]);
  });
});
