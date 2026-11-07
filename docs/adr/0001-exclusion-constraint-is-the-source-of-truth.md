# 0001. The exclusion constraint is the source of truth

Status: Accepted

## Context

Double bookings are the one failure this product must not have. Forty people can submit the same slot
within the same millisecond. A "SELECT to check, then INSERT" sequence is racy under READ COMMITTED
and even under REPEATABLE READ without extra locking.

## Decision

`reservations` carries `EXCLUDE USING gist (resource_id WITH =, tstzrange(starts_at, blocked_until,
'[)') WITH &&) WHERE (status = 'active')`, using the `btree_gist` extension. The application never
decides whether a slot is free; it inserts and interprets SQLSTATE `23P01` as `409 conflict`. Reads
of availability are only for display and suggestions.

## Consequences

- Correctness holds for every writer: API, scripts, future tools.
- PostgreSQL is mandatory, including in tests (see ADR 0004).
- Cancelling is an `UPDATE ... SET status = 'cancelled'`, which removes the row from the constraint.
- Suggestions can be stale by the time the client acts; the client simply tries again.
