# AGENTS.md

Rules for anyone (human or agent) changing Gearslot.

## Project

Media-lab equipment reservations. One job: give a user a confirmed, conflict-free booking of one item
over a half-open `[start, end)` interval, or an immediate explicit rejection. Read
`docs/domain.md` before changing any rule.

## Commands

| Command | What it does |
| ------- | ------------ |
| `pnpm dev` | Next.js dev server (Turbopack) |
| `pnpm check` | typecheck + lint + all tests; must pass before every commit |
| `pnpm test:unit` / `pnpm test:integration` | pure tests / real-Postgres tests (local PostgreSQL) |
| `pnpm db:server` / `db:migrate` / `db:seed` | local PGlite socket server / migrations / dummy data |
| `pnpm scenario` | the 40-way reference scenario |
| `pnpm format` | Biome autofix |

## Layout

```
src/app/               Next.js routes and route handlers (src/app/api)
src/components/        the booking screen (client components, Tailwind)
src/lib/booking/       pure domain core: time, intervals, rules, suggestions (no I/O)
src/lib/db/            Drizzle schema, client
src/lib/reservations/  transactional create/cancel/list, idempotency
src/lib/api/           zod schemas, problem+json, identity
src/lib/client/        browser-side fetch client and key handling
scripts/               CLI tasks: db server, migrate, seed, scenario, admin, purge
drizzle/               generated and hand-written SQL migrations
tests/integration/     tests that need a real PostgreSQL
docs/                  domain, landscape, ADRs, screenshots
```

## Framework rules

- Check current docs (Context7) before touching a library API; do not rely on memory.
- Next.js: App Router, `cacheComponents: true`, `typedRoutes: true`. Reservation data is never cached.
- Prefer platform APIs (`Intl`, `crypto.randomUUID`, `fetch`) over dependencies.
- Route handlers stay thin: parse, call a service, map errors to problem+json.

## Code style

- Biome formats and lints; no `any`, no non-null assertions, `import type` for types.
- Strictest TypeScript flags stay on. Fix the code, not the flags.
- Time is always a UTC instant (`Date` at the edges, ISO-8601 strings on the wire). Local time exists
  only in display code and in `src/lib/booking/zone.ts`.
- Rule defaults are per-instance settings read from the database, never constants.

## Invariants (never break)

1. **No overlap, ever.** The `EXCLUDE USING gist` constraint on `reservations` is the enforcement.
   Application "check then insert" does not count. Never drop, weaken or bypass it.
2. **Concurrent requests resolve deterministically.** Inserts run in a transaction; `23P01` maps to
   `409`; losers never see `500`, a deadlock or a partial write. Anything locking several rows locks
   them in ascending id order through `lockReservationsInOrder`, then takes the resource lock
   (docs/adr/0005). Reschedule and swap are the live examples; swap relies on the constraint being
   `DEFERRABLE INITIALLY IMMEDIATE` (docs/adr/0010), so never defer it anywhere else.
3. **Writes are idempotent.** Create and cancel require `Idempotency-Key`; the same key and body
   replays the stored response, the same key with a different body is `422`.
4. **The buffer counts toward conflicts** through `blocked_until`; a client never supplies it.
5. **No optimistic "booked".** The UI shows success only after the server confirms, an attempt's
   Idempotency-Key is bound to its exact request body, and unloaded availability is unknown, not free
   (docs/adr/0007).

## Data policy

Store an opaque user id and a display name only. No emails, phones, student numbers or other personal
data, in the database, logs, fixtures or screenshots. Cancel changes status; it never deletes.
Reservation history older than 12 months is purged.

## Dependencies

Latest stable, pinned exactly (no `^`/`~`). `minimumReleaseAge` is 10800 minutes. Add a dependency
only when the platform cannot do the job, and record non-obvious choices as an ADR.

## Commits

Conventional Commits, lowercase noun-phrase subject, no body, no trailing period. Scopes match source
folders (`feat(booking)`, `feat(db)`); `docs` and `chore` are unscoped. One concern per commit and each
commit passes `pnpm check`. Single author: no `Co-authored-by` trailers, no tool attribution. Run the
Codex review before every commit.

## Secrets

Never commit `.env` files or credentials. `.env.example` holds placeholders only.
