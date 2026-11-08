# 0004. Real PostgreSQL for concurrency tests, PGlite for local development

Status: Accepted

## Context

Local development should not need an installed database server. PGlite (PostgreSQL compiled to WASM)
supports `btree_gist` but serves one session, so a socket server in front of it serialises clients.
It cannot exercise genuinely concurrent transactions, which is exactly what the core invariants need
tested.

## Decision

- Development and demos: `pnpm db:server` runs PGlite behind a socket (`DATABASE_URL` points at it).
- Tests: integration tests run against a real, locally installed PostgreSQL server named by
  `DATABASE_URL_TEST` (CI installs PostgreSQL 18 on the runner). The concurrency tests open many
  pooled connections and fire simultaneous inserts.
- SQLite and MySQL are rejected: no range types or exclusion constraints.

## Consequences

- `pnpm test:integration` requires `DATABASE_URL_TEST` to point at a local PostgreSQL test database,
  which the tests truncate; the setup refuses any database whose name does not end in `_test`.
- Pure unit and property tests need no database and run in `pnpm test:unit`.
- Behaviour seen in development (single session) is a subset of production behaviour; the integration
  suite is the authority.
