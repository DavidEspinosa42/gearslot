# 0010. Reschedule and swap both lock rows in order; the constraint is deferrable

Status: Accepted (supersedes the first version of this record, which deferred swap)

## Context

Operations that touch several reservations must lock them in a consistent order so two of them can
never wait on each other. v1 needs real operations that exercise that rule: moving one's own booking
(reschedule) and exchanging two of one's own bookings of the same item (swap).

Swap cannot work with an immediate exclusion constraint. The constraint is checked per row, so moving
the first booking onto the second one's range fails at the first `UPDATE`, even though the final state
is valid.

## Decision

- **Reschedule** (`POST /api/reservations/{id}/reschedule`) locks the reservation through
  `lockReservationsInOrder`, takes the resource lock, and updates through the same exclusion constraint
  as a create, so a clash is a `409` and the old slot is kept.
- **Swap** (`POST /api/reservations/swap`) locks both rows through `lockReservationsInOrder` (ascending
  id), takes the resource lock, and inside a savepoint runs `SET CONSTRAINTS reservations_no_overlap
  DEFERRED`, exchanges the two ranges, then `SET CONSTRAINTS ... IMMEDIATE` to run the check before the
  savepoint is released. A violation is a clean `23P01` there and maps to `409`.
- Migration 0003 recreates the constraint as `DEFERRABLE INITIALLY IMMEDIATE`. Everywhere except the
  swap transaction nothing changes: every statement is still checked at once. A test asserts the
  constraint is deferrable and not deferred, and that an ordinary overlap is still refused immediately.
- Swap is limited to two bookings of one person on the same item that have not started. Because both
  ranges and the buffer are exchanged as a pair, a swap only permutes blocked ranges that already
  existed, so it cannot collide with a third booking.

## Consequences

- Reschedule keeps an immutable `create_hash` on each reservation so a purged create key is still
  recognised after the booking has moved (rows from before the column get it on their first move).
- Concurrent swaps over the same pair in opposite argument orders cannot deadlock; a test runs twenty.
- The constraint remains the enforcement for invariant 1; deferral is confined to one transaction type
  and the check is forced before it can commit.
