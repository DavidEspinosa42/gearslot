import { type Interval, MS_PER_DAY, MS_PER_MINUTE } from "./interval";

/** Per-instance booking rules. Loaded from the `lab_settings` table, never hard-coded. */
export interface BookingRules {
  /** Grid size in minutes; every start and end is a multiple of it. */
  readonly slotMinutes: number;
  readonly minMinutes: number;
  readonly maxMinutes: number;
  /** How far ahead a booking may end, in days. */
  readonly horizonDays: number;
}

export type RuleCode =
  | "invalid_range"
  | "not_aligned"
  | "too_short"
  | "too_long"
  | "in_past"
  | "beyond_horizon";

export interface RuleViolation {
  readonly code: RuleCode;
  readonly message: string;
}

/** Documented defaults, used to seed a new instance's settings row. */
export const DEFAULT_RULES: BookingRules = {
  slotMinutes: 15,
  minMinutes: 15,
  maxMinutes: 72 * 60,
  horizonDays: 30,
};

export function slotMs(rules: BookingRules): number {
  return rules.slotMinutes * MS_PER_MINUTE;
}

export function isOnGrid(instant: number, rules: BookingRules): boolean {
  return Number.isInteger(instant) && instant % slotMs(rules) === 0;
}

/** The first grid boundary at or after `instant`. */
export function ceilToSlot(instant: number, rules: BookingRules): number {
  const size = slotMs(rules);
  return Math.ceil(instant / size) * size;
}

/**
 * Every rule a requested booking breaks, in a stable order. An empty list means the request is
 * acceptable as far as pure rules go; whether the slot is free is the database's decision.
 */
export function validateBooking(
  request: Interval,
  now: number,
  rules: BookingRules,
): RuleViolation[] {
  if (!(request.end > request.start)) {
    return [{ code: "invalid_range", message: "The end must be after the start." }];
  }

  const violations: RuleViolation[] = [];
  if (!isOnGrid(request.start, rules) || !isOnGrid(request.end, rules)) {
    violations.push({
      code: "not_aligned",
      message: `Start and end must fall on ${rules.slotMinutes}-minute boundaries.`,
    });
  }

  const minutes = (request.end - request.start) / MS_PER_MINUTE;
  if (minutes < rules.minMinutes) {
    violations.push({
      code: "too_short",
      message: `A booking must be at least ${rules.minMinutes} minutes.`,
    });
  }
  if (minutes > rules.maxMinutes) {
    violations.push({
      code: "too_long",
      message: `A booking can be at most ${rules.maxMinutes / 60} hours.`,
    });
  }
  if (request.start < now) {
    violations.push({ code: "in_past", message: "A booking cannot start in the past." });
  }
  if (request.end > now + rules.horizonDays * MS_PER_DAY) {
    violations.push({
      code: "beyond_horizon",
      message: `A booking cannot end more than ${rules.horizonDays} days ahead.`,
    });
  }
  return violations;
}

/** True when holding `activeCount` reservations already uses up the per-category allowance. */
export function isQuotaReached(activeCount: number, maxActivePerUser: number): boolean {
  return activeCount >= maxActivePerUser;
}
