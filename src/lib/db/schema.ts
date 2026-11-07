import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Per-instance settings: the single row replaces constants for the booking rules.
 * `id` is always `true` so the table can hold at most one row.
 */
export const labSettings = pgTable(
  "lab_settings",
  {
    id: boolean("id").primaryKey().default(true),
    timezone: text("timezone").notNull().default("America/Argentina/Buenos_Aires"),
    slotMinutes: integer("slot_minutes").notNull().default(15),
    minMinutes: integer("min_minutes").notNull().default(15),
    maxMinutes: integer("max_minutes").notNull().default(4320),
    horizonDays: integer("horizon_days").notNull().default(30),
    retentionMonths: integer("retention_months").notNull().default(12),
  },
  (t) => [
    check("lab_settings_single_row", sql`${t.id}`),
    check("lab_settings_slot_positive", sql`${t.slotMinutes} > 0`),
    check("lab_settings_bounds", sql`${t.minMinutes} > 0 AND ${t.maxMinutes} >= ${t.minMinutes}`),
    check("lab_settings_horizon_positive", sql`${t.horizonDays} > 0`),
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    maxActivePerUser: integer("max_active_per_user").notNull(),
  },
  (t) => [check("categories_cap_non_negative", sql`${t.maxActivePerUser} >= 0`)],
);

export const resources = pgTable(
  "resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    /** Resources with the same model are interchangeable (identical units). */
    model: text("model").notNull(),
    locationLabel: text("location_label").notNull(),
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("resources_buffer_non_negative", sql`${t.bufferMinutes} >= 0`),
    index("resources_model_idx").on(t.model),
  ],
);

/** Opaque SSO subject and display name. Nothing else about a person is stored. */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A claim on one resource for `[starts_at, ends_at)`. `blocked_until` is `ends_at` plus the
 * resource buffer at booking time and is set by the server. The exclusion constraint
 * `reservations_no_overlap` (see the hand-written migration) is what forbids double bookings.
 */
export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["active", "cancelled"] })
      .notNull()
      .default("active"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** Fingerprint of the original create request. Immutable: a reschedule must not change it. */
    createHash: text("create_hash").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [
    check("reservations_range_valid", sql`${t.endsAt} > ${t.startsAt}`),
    check("reservations_blocked_covers_end", sql`${t.blockedUntil} >= ${t.endsAt}`),
    check("reservations_status_valid", sql`${t.status} IN ('active', 'cancelled')`),
    unique("reservations_user_key_unique").on(t.userId, t.idempotencyKey),
    index("reservations_user_status_idx").on(t.userId, t.status),
    index("reservations_resource_start_idx").on(t.resourceId, t.startsAt),
    index("reservations_created_at_idx").on(t.createdAt),
  ],
);

/** Stored outcome of a create or cancel, so retries replay instead of repeating the effect. */
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code").notNull(),
    response: jsonb("response").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.key] }),
    index("idempotency_records_created_at_idx").on(t.createdAt),
  ],
);

export type Resource = typeof resources.$inferSelect;
export type Reservation = typeof reservations.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type LabSettings = typeof labSettings.$inferSelect;
