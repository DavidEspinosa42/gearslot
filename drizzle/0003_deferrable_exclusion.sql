-- Hand-written migration. Same constraint as 0001 (invariant 1, docs/adr/0001), now DEFERRABLE
-- INITIALLY IMMEDIATE. Day to day nothing changes: every statement is still checked immediately, so
-- a clash is 23P01 at once. Only the swap transaction (docs/adr/0010) runs
-- SET CONSTRAINTS ... DEFERRED, exchanges two ranges, and then forces the check with
-- SET CONSTRAINTS ... IMMEDIATE before it can commit.
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_no_overlap";--> statement-breakpoint
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_overlap"
  EXCLUDE USING gist (
    "resource_id" WITH =,
    tstzrange("starts_at", "blocked_until", '[)') WITH &&
  ) WHERE ("status" = 'active')
  DEFERRABLE INITIALLY IMMEDIATE;
