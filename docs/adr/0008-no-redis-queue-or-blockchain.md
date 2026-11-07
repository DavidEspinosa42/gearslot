# 0008. No distributed lock, no queue, no blockchain

Status: Accepted

## Context

"Many people booking at once" tempts toward a Redis lock, a message queue that serialises requests, or
an append-only ledger for trust. Each adds a second system that can disagree with the database.

## Decision

None of them. One PostgreSQL database is the only place that decides who holds a slot, through the
exclusion constraint (ADR 0001). Ordering comes from transaction-scoped advisory locks in that same
database (ADR 0005). Auditability comes from keeping cancelled rows with a status instead of deleting
them. The lab's load is a burst of dozens of requests, which one database handles in well under a
second (the scenario script shows about 0.4 s for 40).

## Consequences

- There is no queue to lose messages, no lock service to expire early, and nothing to keep in sync.
- Horizontal scale beyond one primary database is out of scope. It would be done with a larger
  instance first.
- A ledger or signed receipts could be added later as a read-only export without changing the core.
