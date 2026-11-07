import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MS_PER_DAY, MS_PER_MINUTE } from "./interval";
import {
  ceilToSlot,
  DEFAULT_RULES,
  isOnGrid,
  isQuotaReached,
  type RuleCode,
  slotMs,
  validateBooking,
} from "./rules";

const NOW = Date.UTC(2026, 10, 9, 12, 0); // on the grid
const SLOT = slotMs(DEFAULT_RULES);
const codes = (start: number, end: number): RuleCode[] =>
  validateBooking({ start, end }, NOW, DEFAULT_RULES).map((v) => v.code);

describe("validateBooking", () => {
  it("accepts a one hour booking tomorrow", () => {
    expect(codes(NOW + MS_PER_DAY, NOW + MS_PER_DAY + 60 * MS_PER_MINUTE)).toEqual([]);
  });

  it("accepts starting exactly now", () => {
    expect(codes(NOW, NOW + SLOT)).toEqual([]);
  });

  it("rejects the past, even by one slot", () => {
    expect(codes(NOW - SLOT, NOW + SLOT)).toEqual(["in_past"]);
  });

  it("rejects off-grid starts and ends", () => {
    expect(codes(NOW + SLOT + 1000, NOW + 3 * SLOT)).toContain("not_aligned");
    expect(codes(NOW + SLOT, NOW + 3 * SLOT + 60_000)).toContain("not_aligned");
  });

  it("enforces the length bounds exactly", () => {
    expect(codes(NOW, NOW + SLOT)).toEqual([]);
    expect(codes(NOW, NOW + 72 * 60 * MS_PER_MINUTE)).toEqual([]);
    expect(codes(NOW, NOW + 72 * 60 * MS_PER_MINUTE + SLOT)).toEqual(["too_long"]);
  });

  it("rejects empty and reversed ranges", () => {
    expect(codes(NOW + SLOT, NOW + SLOT)).toEqual(["invalid_range"]);
    expect(codes(NOW + 2 * SLOT, NOW + SLOT)).toEqual(["invalid_range"]);
  });

  it("allows ending exactly at the horizon and rejects one slot beyond", () => {
    const horizon = NOW + 30 * MS_PER_DAY;
    expect(codes(horizon - SLOT, horizon)).toEqual([]);
    expect(codes(horizon, horizon + SLOT)).toEqual(["beyond_horizon"]);
  });

  it("honours per-instance rules instead of constants", () => {
    const strict = { slotMinutes: 30, minMinutes: 60, maxMinutes: 120, horizonDays: 7 };
    const start = NOW + MS_PER_DAY;
    const result = validateBooking({ start, end: start + 30 * MS_PER_MINUTE }, NOW, strict);
    expect(result.map((v) => v.code)).toEqual(["too_short"]);
  });

  it("accepts every grid-aligned, in-bounds request (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 * 96 - 288 }),
        fc.integer({ min: 1, max: 288 }),
        (startSlots, lengthSlots) => {
          const start = NOW + startSlots * SLOT;
          const end = start + lengthSlots * SLOT;
          expect(validateBooking({ start, end }, NOW, DEFAULT_RULES)).toEqual([]);
        },
      ),
    );
  });

  it("rejects every start that is not a multiple of the slot (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: SLOT - 1 }),
        fc.integer({ min: 1, max: 100 }),
        (offset, slots) => {
          const start = NOW + slots * SLOT + offset;
          const found = validateBooking({ start, end: start + 4 * SLOT }, NOW, DEFAULT_RULES);
          expect(found.map((v) => v.code)).toContain("not_aligned");
        },
      ),
    );
  });
});

describe("grid helpers", () => {
  it("ceilToSlot returns the nearest boundary at or after the instant", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_000_000_000_000 }), (instant) => {
        const ceiled = ceilToSlot(instant, DEFAULT_RULES);
        expect(isOnGrid(ceiled, DEFAULT_RULES)).toBe(true);
        expect(ceiled).toBeGreaterThanOrEqual(instant);
        expect(ceiled - instant).toBeLessThan(SLOT);
      }),
    );
  });
});

describe("isQuotaReached", () => {
  it("blocks exactly at the cap", () => {
    expect(isQuotaReached(2, 3)).toBe(false);
    expect(isQuotaReached(3, 3)).toBe(true);
    expect(isQuotaReached(0, 0)).toBe(true);
  });
});
