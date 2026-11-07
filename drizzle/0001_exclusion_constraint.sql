-- Hand-written migration: Drizzle cannot express exclusion constraints.
-- This constraint is invariant 1 (see AGENTS.md and docs/adr/0001): no two active reservations of
-- one resource may have overlapping [starts_at, blocked_until) ranges. blocked_until already
-- includes the resource buffer (docs/adr/0002). Application code never replaces this check.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_overlap"
  EXCLUDE USING gist (
    "resource_id" WITH =,
    tstzrange("starts_at", "blocked_until", '[)') WITH &&
  ) WHERE ("status" = 'active');--> statement-breakpoint
INSERT INTO "lab_settings" ("id") VALUES (true) ON CONFLICT DO NOTHING;
