# 0010. Reschedule ships in v1; swap is deferred

Status: Accepted

## Context

Operations that touch several reservations must lock them in a consistent order so two of them can
never wait on each other. v1 needs a real operation that exercises that rule. Two kinds were
considered: moving one's own booking (reschedule) and exchanging slots between two bookings (swap).

## Decision

Ship reschedule (`POST /api/reservations/{id}/reschedule`). It locks the reservation through
`lockReservationsInOrder`, takes the resource lock, and updates through the same exclusion
constraint as a create, so a clash is a `409` and the old slot is kept.

Defer swap. The exclusion constraint is checked per row and is not deferrable, so exchanging two
ranges inside one transaction fails on the first `UPDATE` even though the final state is valid. A
correct swap needs the constraint to be `DEFERRABLE` and the transaction to run
`SET CONSTRAINTS ... DEFERRED`, which moves the `23P01` to commit time and needs separate handling of
the stored idempotent outcome. That is a deliberate change to invariant 1's machinery and is tracked
in the roadmap rather than rushed into v1.

## Consequences

- Reschedule keeps an immutable `create_hash` on each reservation so a purged create key is still
  recognised after the booking has moved (rows from before the column get it on their first move).
- `lockReservationsInOrder` and its ordering test stay in place for the future swap.
