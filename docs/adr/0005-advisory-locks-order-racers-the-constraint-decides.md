# 0005. Advisory locks order racers; the constraint still decides

Status: Accepted

## Context

Two concurrent inserts that conflict under an exclusion constraint each wait for the other's
uncommitted row. PostgreSQL resolves the cycle by aborting one with `40P01` after
`deadlock_timeout` (1 s by default). In the 40-way reference scenario that meant many 1 s stalls, and
a test timeout. A per-user category cap also needs a count-then-insert that parallel requests could
beat.

## Decision

Inside the booking transaction, before the insert, take two transaction-scoped advisory locks in a
fixed order: `user + category` (so the cap check is serialised per person), then the resource. Full
order of acquisition: idempotency row, user row, user+category lock, resource lock. The exclusion
constraint remains the enforcement: a test fires raw concurrent inserts with no lock and still gets
exactly one winner. Transactions that fail with `40P01` or `40001` are re-run up to five times, and
only then answered with `503 busy`, never `500`.

## Consequences

- Bookings for one resource are serialised for the few milliseconds the transaction takes. That is
  the right trade for a lab with tens of items.
- Correctness never depends on the locks; they only make losers fail fast and cleanly.
- Any future operation touching several reservations must lock them in ascending id order through
  `lockReservationsInOrder`, and take the resource lock after.
