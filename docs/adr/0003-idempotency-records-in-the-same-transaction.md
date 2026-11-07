# 0003. Idempotency records live in the booking transaction

Status: Accepted

## Context

Phones on flaky Wi-Fi retry, and users double-tap. A retry must never create a second booking or
cancel twice, even when the first request committed but its response was lost, and even when two
copies of the same request arrive concurrently.

## Decision

An `idempotency_records` table keyed by `(user_id, key)` stores the request hash, the response status
and the response body. Each write runs in one transaction: insert the record with `ON CONFLICT DO
NOTHING`; if it already exists, replay the stored response (or `422` when the hash differs); otherwise
perform the work and store the response in the same transaction. The reservation insert runs inside a
savepoint so a `23P01` can be rolled back and its `409` stored, while the transaction commits.
Concurrent duplicates block on the unique index until the first commits, then replay.

## Consequences

- A stored `409` is replayed for the same key. A new attempt after a conflict uses a new key.
- Records are small and purged after 7 days.
- No external store (Redis) is needed.
