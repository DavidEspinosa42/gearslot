import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { blockedRange, type Interval, MS_PER_DAY, MS_PER_MINUTE, overlaps } from "./interval";
import { DEFAULT_RULES, isOnGrid, slotMs, validateBooking } from "./rules";
import {
  type Block,
  daySlots,
  durationPresets,
  initialMinutes,
  maxBookableMinutes,
  slotState,
} from "./timeline";
import { localDayWindow } from "./zone";

const NOW = Date.UTC(2026, 10, 9, 12, 0);
const SLOT = slotMs(DEFAULT_RULES);
const rules = DEFAULT_RULES;
const at = (slots: number) => NOW + slots * SLOT;

describe("daySlots", () => {
  it("gives 96 slots on an ordinary day, all on the grid and inside the day", () => {
    const day = localDayWindow("2026-11-13", "America/Argentina/Buenos_Aires");
    const slots = daySlots(day, rules);
    expect(slots).toHaveLength(96);
    for (const slot of slots) {
      expect(isOnGrid(slot.start, rules)).toBe(true);
      expect(slot.start).toBeGreaterThanOrEqual(day.start);
      expect(slot.end).toBeLessThanOrEqual(day.end);
    }
  });

  it("gives 92 and 100 slots on 23 and 25 hour days", () => {
    expect(daySlots(localDayWindow("2026-03-08", "America/New_York"), rules)).toHaveLength(92);
    expect(daySlots(localDayWindow("2026-11-01", "America/New_York"), rules)).toHaveLength(100);
  });

  it("never lists the same instant twice across consecutive days", () => {
    const first = daySlots(localDayWindow("2026-11-01", "America/New_York"), rules);
    const second = daySlots(localDayWindow("2026-11-02", "America/New_York"), rules);
    const seen = new Set(first.map((s) => s.start));
    for (const slot of second) expect(seen.has(slot.start)).toBe(false);
  });
});

describe("slotState", () => {
  const taken: Block[] = [{ start: at(8), end: at(12), mine: false }];
  const mine: Block[] = [{ start: at(8), end: at(12), mine: true }];
  const slot = (n: number): Interval => ({ start: at(n), end: at(n + 1) });

  it("marks overlapping slots taken or mine, and touching slots free", () => {
    expect(slotState(slot(8), taken, NOW, rules)).toBe("taken");
    expect(slotState(slot(11), taken, NOW, rules)).toBe("taken");
    expect(slotState(slot(12), taken, NOW, rules)).toBe("free");
    expect(slotState(slot(7), taken, NOW, rules)).toBe("free");
    expect(slotState(slot(9), mine, NOW, rules)).toBe("mine");
  });

  it("marks the past and the far future as unavailable", () => {
    expect(slotState(slot(-1), [], NOW, rules)).toBe("past");
    expect(
      slotState(
        { start: NOW + 30 * MS_PER_DAY, end: NOW + 30 * MS_PER_DAY + SLOT },
        [],
        NOW,
        rules,
      ),
    ).toBe("beyond");
  });
});

describe("maxBookableMinutes", () => {
  it("stops at the next taken block", () => {
    const blocks: Block[] = [{ start: at(8), end: at(12), mine: false }];
    expect(maxBookableMinutes(at(4), blocks, 0, NOW, rules)).toBe(60);
  });

  it("keeps room for the booking's own buffer", () => {
    const blocks: Block[] = [{ start: at(8), end: at(12), mine: false }];
    expect(maxBookableMinutes(at(4), blocks, 30, NOW, rules)).toBe(30);
  });

  it("is 0 where a block already sits, in the past, or too close to fit the minimum", () => {
    const blocks: Block[] = [{ start: at(8), end: at(12), mine: false }];
    expect(maxBookableMinutes(at(9), blocks, 0, NOW, rules)).toBe(0);
    expect(maxBookableMinutes(at(-2), blocks, 0, NOW, rules)).toBe(0);
    expect(maxBookableMinutes(at(7), blocks, 15, NOW, rules)).toBe(0);
  });

  it("caps at the maximum length and at the horizon", () => {
    expect(maxBookableMinutes(at(4), [], 0, NOW, rules)).toBe(72 * 60);
    const nearHorizon = NOW + 30 * MS_PER_DAY - 2 * SLOT;
    expect(maxBookableMinutes(nearHorizon, [], 0, NOW, rules)).toBe(30);
  });

  it("returns a booking the server would accept, and one slot more would not fit (property)", () => {
    const blocksArb = fc
      .array(fc.tuple(fc.integer({ min: 0, max: 400 }), fc.integer({ min: 1, max: 30 })), {
        maxLength: 10,
      })
      .map((pairs) =>
        pairs.map(([s, l]): Block => ({ start: at(s), end: at(s + l), mine: false })),
      );
    fc.assert(
      fc.property(
        blocksArb,
        fc.integer({ min: 0, max: 450 }),
        fc.constantFrom(0, 30),
        (blocks, startSlot, buffer) => {
          const start = at(startSlot);
          const minutes = maxBookableMinutes(start, blocks, buffer, NOW, rules);
          if (minutes === 0) return;
          const booked: Interval = { start, end: start + minutes * MS_PER_MINUTE };
          expect(validateBooking(booked, NOW, rules)).toEqual([]);
          for (const block of blocks)
            expect(overlaps(blockedRange(booked, buffer), block)).toBe(false);

          const longer: Interval = { start, end: booked.end + SLOT };
          const stillOk =
            validateBooking(longer, NOW, rules).length === 0 &&
            blocks.every((block) => !overlaps(blockedRange(longer, buffer), block));
          expect(stillOk).toBe(false);
        },
      ),
    );
  });

  it("agrees with a brute-force search over durations (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 1, max: 8 })), {
          maxLength: 5,
        }),
        fc.integer({ min: 0, max: 70 }),
        fc.constantFrom(0, 30),
        (pairs, startSlot, buffer) => {
          const blocks = pairs.map(
            ([s, l]): Block => ({ start: at(s), end: at(s + l), mine: false }),
          );
          const start = at(startSlot);
          let best = 0;
          for (let slots = 1; slots <= 288; slots += 1) {
            const candidate: Interval = { start, end: start + slots * SLOT };
            const free = blocks.every((b) => !overlaps(blockedRange(candidate, buffer), b));
            if (free && validateBooking(candidate, NOW, rules).length === 0) best = slots * 15;
            else if (!free) break;
          }
          expect(maxBookableMinutes(start, blocks, buffer, NOW, rules)).toBe(best);
        },
      ),
    );
  });
});

describe("initialMinutes and durationPresets", () => {
  it("default to one hour on the standard grid", () => {
    expect(initialMinutes(240, rules)).toBe(60);
    expect(initialMinutes(30, rules)).toBe(30);
    expect(durationPresets(240, rules)).toEqual([30, 60, 120, 240]);
    expect(durationPresets(90, rules)).toEqual([30, 60]);
  });

  it("respect a 45-minute grid: nothing off-grid is offered", () => {
    const grid45 = { slotMinutes: 45, minMinutes: 45, maxMinutes: 360, horizonDays: 30 };
    expect(initialMinutes(180, grid45)).toBe(45);
    expect(durationPresets(180, grid45)).toEqual([]);
  });

  it("respect a minimum above the preferred length", () => {
    const strict = { slotMinutes: 15, minMinutes: 120, maxMinutes: 480, horizonDays: 30 };
    expect(initialMinutes(240, strict)).toBe(120);
    expect(durationPresets(240, strict)).toEqual([120, 240]);
  });

  it("always yields a length the rules accept (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(15, 30, 45, 60),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 40 }),
        (slot, minSlots, fitSlots) => {
          const custom = {
            slotMinutes: slot,
            minMinutes: minSlots * slot,
            maxMinutes: 100 * slot,
            horizonDays: 30,
          };
          const fits = Math.max(fitSlots, minSlots) * slot;
          const minutes = initialMinutes(fits, custom);
          expect(minutes % slot).toBe(0);
          expect(minutes).toBeGreaterThanOrEqual(custom.minMinutes);
          expect(minutes).toBeLessThanOrEqual(fits);
          for (const preset of durationPresets(fits, custom)) {
            expect(preset % slot).toBe(0);
            expect(preset).toBeGreaterThanOrEqual(custom.minMinutes);
            expect(preset).toBeLessThanOrEqual(fits);
          }
        },
      ),
    );
  });
});
