# 0002. The buffer is stored as `blocked_until`

Status: Accepted

## Context

An exclusion constraint may only use expressions over the row's own columns, so it cannot read a
resource's current `buffer_minutes` from another table. The buffer must still count toward conflicts.

## Decision

Each reservation stores `blocked_until = ends_at + buffer`, computed server-side inside the insert
transaction from the resource's buffer at that moment. The constraint uses
`tstzrange(starts_at, blocked_until, '[)')`. A `CHECK (blocked_until >= ends_at)` guards it.
Clients never send `blocked_until`.

## Consequences

- Changing a resource's buffer later does not alter existing reservations (a snapshot, as users
  agreed to the rules in force when they booked). New bookings use the new buffer.
- A request that ends inside a previous job's buffer conflicts, and so does one that would run into the
  next job's start, because both ranges include their own buffer.
- Availability endpoints return blocked ranges, so the UI greys out buffer time too.
