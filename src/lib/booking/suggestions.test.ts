import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  blockedRange,
  type Interval,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  overlaps,
} from "./interval";
import { DEFAULT_RULES, isOnGrid, slotMs, validateBooking } from "./rules";
import { type Candidate, freeIdenticalUnits, nextFreeSlots } from "./suggestions";

const NOW = Date.UTC(2026, 10, 9, 12, 0);
const SLOT = slotMs(DEFAULT_RULES);
const hour = (h: number): number => NOW + h * MS_PER_HOUR;

describe("freeIdenticalUnits", () => {
  const request: Interval = { start: hour(100), end: hour(104) };
  const camera = (id: string, blocked: Interval[]): Candidate => ({
    id,
    name: `Camera ${id}`,
    bufferMinutes: 0,
    blocked,
  });

  it("returns only units with no overlapping block, in input order", () => {
    const units = [
      camera("1", [{ start: hour(101), end: hour(102) }]),
      camera("3", []),
      camera("4", [{ start: hour(104), end: hour(106) }]),
    ];
    expect(freeIdenticalUnits(request, units).map((u) => u.id)).toEqual(["3", "4"]);
  });

  it("accounts for the candidate's own buffer", () => {
    const printer: Candidate = {
      id: "p",
      name: "Printer",
      bufferMinutes: 30,
      blocked: [{ start: hour(104) + 15 * MS_PER_MINUTE, end: hour(105) }],
    };
    expect(freeIdenticalUnits(request, [printer])).toEqual([]);
  });
});

describe("nextFreeSlots", () => {
  const rules = DEFAULT_RULES;

  it("skips the busy block and proposes the first fitting slot after it", () => {
    const request: Interval = { start: hour(100), end: hour(104) };
    const blocked: Interval[] = [{ start: hour(98), end: hour(106) }];
    const [first] = nextFreeSlots({
      request,
      blocked,
      bufferMinutes: 0,
      now: NOW,
      rules,
      limit: 3,
    });
    expect(first).toEqual({ start: hour(106), end: hour(110) });
  });

  it("does not suggest a slot whose own buffer would run into the next booking", () => {
    const request: Interval = { start: hour(100), end: hour(102) };
    const blocked: Interval[] = [
      { start: hour(100), end: hour(102) + 30 * MS_PER_MINUTE },
      { start: hour(104), end: hour(106) },
    ];
    // The gap [102:30, 104) is 90 minutes; a 2h job plus 30 min buffer cannot fit before 104:00.
    const result = nextFreeSlots({
      request,
      blocked,
      bufferMinutes: 30,
      now: NOW,
      rules,
      limit: 2,
    });
    expect(result[0]?.start).toBe(hour(106));
  });

  it("returns nothing when the horizon is exhausted", () => {
    const request: Interval = { start: hour(100), end: hour(104) };
    const blocked: Interval[] = [{ start: NOW, end: NOW + 31 * MS_PER_DAY }];
    expect(
      nextFreeSlots({ request, blocked, bufferMinutes: 0, now: NOW, rules, limit: 3 }),
    ).toEqual([]);
  });

  it("only proposes bookings that pass every rule and avoid every block (property)", () => {
    const blockedArb = fc
      .array(fc.tuple(fc.integer({ min: 0, max: 700 }), fc.integer({ min: 1, max: 40 })), {
        maxLength: 15,
      })
      .map((pairs) =>
        pairs.map(
          ([startSlot, lengthSlots]): Interval => ({
            start: NOW + startSlot * SLOT,
            end: NOW + (startSlot + lengthSlots) * SLOT,
          }),
        ),
      );
    fc.assert(
      fc.property(
        blockedArb,
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 1, max: 32 }),
        fc.constantFrom(0, 30, 45),
        (blocked, startSlot, lengthSlots, bufferMinutes) => {
          const request: Interval = {
            start: NOW + startSlot * SLOT,
            end: NOW + (startSlot + lengthSlots) * SLOT,
          };
          const found = nextFreeSlots({
            request,
            blocked,
            bufferMinutes,
            now: NOW,
            rules,
            limit: 5,
          });
          let previousStart = -Infinity;
          for (const slot of found) {
            expect(isOnGrid(slot.start, rules)).toBe(true);
            expect(slot.end - slot.start).toBe(request.end - request.start);
            expect(slot.start).toBeGreaterThanOrEqual(request.start);
            expect(slot.start).toBeGreaterThan(previousStart);
            previousStart = slot.start;
            expect(validateBooking(slot, NOW, rules)).toEqual([]);
            const needed = blockedRange(slot, bufferMinutes);
            for (const block of blocked) expect(overlaps(needed, block)).toBe(false);
          }
        },
      ),
    );
  });

  it("respects the limit", () => {
    const request: Interval = { start: hour(100), end: hour(101) };
    const result = nextFreeSlots({
      request,
      blocked: [],
      bufferMinutes: 0,
      now: NOW,
      rules,
      limit: 1,
    });
    expect(result).toHaveLength(1);
  });
});
