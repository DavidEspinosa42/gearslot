# 0004. Real PostgreSQL for concurrency tests, PGlite for local development

Status: Accepted

## Context

Local development should not need Docker or installed services. PGlite (PostgreSQL compiled to WASM)
supports `btree_gist` but serves one session, so a socket server in front of it serialises clients.
It cannot exercise genuinely concurrent transactions, which is exactly what the core invariants need
tested.

## Decision

- Development and demos: `pnpm db:server` runs PGlite behind a socket (`DATABASE_URL` points at it).
- Tests: integration tests run against a real PostgreSQL server, started by Testcontainers, or
  `DATABASE_URL_TEST` when provided (CI service container). The concurrency tests open many pooled
  connections and fire simultaneous inserts.
- SQLite and MySQL are rejected: no range types or exclusion constraints.

## Consequences

- `pnpm test:integration` requires Docker unless `DATABASE_URL_TEST` is set.
- Pure unit and property tests need no database and run in `pnpm test:unit`.
- Behaviour seen in development (single session) is a subset of production behaviour; the integration
  suite is the authority.
