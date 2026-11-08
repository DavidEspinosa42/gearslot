<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md

## Project

Gearslot: media-lab equipment reservations. One job: give a user a confirmed, conflict-free booking of
one item over a half-open `[start, end)` interval, or an immediate explicit rejection. Read
`docs/domain.md` before changing any rule. Planned work is in `ROADMAP.md`.

## Commands

- Install: `pnpm install`, then copy `.env.example` to `.env`.
- Local database: `pnpm db:server`, in its own terminal (PGlite behind a socket on `DATABASE_URL`).
  Development only; it serves one session, so it cannot test concurrency.
- Migrations: `pnpm db:migrate` (with `db:server` running).
- New migration after editing `src/lib/db/schema.ts`: `pnpm db:generate --name <change>`.
  Hand-written SQL migrations (the exclusion constraint) live in `drizzle/` too; never edit an
  applied migration, add a new one.
- Seed dummy data: `pnpm db:seed` (with `db:server` running).
- Dev server: `pnpm dev` (Turbopack, needs `db:server` running).
- Production build: `pnpm build`, then `pnpm start`.
- Reference scenario (40 simultaneous bookings, one winner): `pnpm scenario` against the database,
  or `pnpm scenario:http` over real HTTP against `pnpm build && pnpm start` (set `BASE_URL`).
- Operator actions in place of an admin UI: `pnpm admin -- <command>`. Retention purge: `pnpm purge`.
- Integration tests: `pnpm test:integration`. They need a locally installed PostgreSQL 18 and
  `DATABASE_URL_TEST` pointing at a database whose name ends in `_test` (the suite truncates every
  table and refuses to start otherwise). Setup is in the README.
- Type check: `pnpm typecheck` (runs `next typegen`, then `tsc --noEmit`).
- Lint and format check: `pnpm lint` (Biome); auto-fix: `pnpm format`.
- Tests: `pnpm test` (unit and integration); `pnpm test:unit` needs no database; one file:
  `pnpm test path/to/file.test.ts`.
- Before finishing any change, run `pnpm check` (typecheck, lint, all tests). It must pass.

## Layout

- `src/lib/booking/`: pure domain core (time, intervals, rules, suggestions). No I/O.
- `src/lib/db/`: Drizzle schema and client.
- `src/lib/reservations/`: transactional create, cancel and list, idempotency, retention purge.
- `src/lib/api/`: zod schemas, problem+json, identity.
- `src/lib/client/`: browser-side fetch client and idempotency key handling.
- `src/app/`: Next.js routes; `src/app/api/`: route handlers. `src/components/`: the booking screen
  (client components, Tailwind).
- `scripts/`: command-line tasks run outside Next (db server, migrate, seed, scenario, admin, purge).
- `drizzle/`: generated and hand-written SQL migrations.
- `tests/integration/`: tests that need a real PostgreSQL. Other tests live next to the code as
  `*.test.ts`.
- `docs/`: `domain.md` (rules and terms), `landscape.md`, `adr/` (architecture decision records),
  `screenshots/` (shown in the README).

## Next.js and database rules

- App Router, `cacheComponents: true`, `typedRoutes: true`. Reservation data is never cached.
- Route handlers stay thin: parse, call a service, map errors to problem+json.
- Prefer platform APIs (`Intl`, `crypto.randomUUID`, `fetch`) over dependencies.
- Check current library docs before touching a library API; do not rely on memory.
- Time is always a UTC instant (`Date` at the edges, ISO-8601 strings on the wire). Local time exists
  only in display code and in `src/lib/booking/zone.ts`.
- Rule defaults are per-instance settings read from the database, never constants.
- Integration and concurrency tests run on real PostgreSQL, never SQLite, MySQL or PGlite
  (docs/adr/0004).

## Code style

- TypeScript with the strictest flags on; fix the code, not the flags.
- No `any`, no `!` non-null assertions, `import type` for types.
- Validate all external input with zod at the boundary (API bodies, queries, headers).
- Let Biome format and lint; do not hand-format.
- Comments explain why, not what.
- When a change alters a domain rule, update `docs/domain.md` in the same commit. When it reverses or
  adds a design decision, add an ADR to `docs/adr/`.

## Integrity rules (never break)

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

- Store an opaque user id and a display name only. No emails, phones, student numbers or other
  personal data, in the database, logs, fixtures or screenshots.
- Cancel changes status; it never deletes. Reservation history older than 12 months is purged.
- Fixtures, seeds, scenarios and tests use generated dummy data only.

## Dependencies

- Ask before adding a dependency; add one only when the platform cannot do the job, and record
  non-obvious choices as an ADR.
- Latest stable, pinned exactly (no `^` or `~`; `savePrefix` is empty).
- Never lower `minimumReleaseAge` (10080 minutes) or loosen `trustPolicy` to get a fresh release
  installed; wait for it instead.
- Use the Node and pnpm versions pinned in `devEngines`; do not add `.nvmrc`.

## Commits

- Conventional Commits: lowercase noun-phrase subject, no body, no trailing period. Scopes match source
  folders (`feat(booking)`, `feat(db)`); `docs` and `chore` are unscoped.
- One concern per commit, small enough to review line by line. Each commit passes `pnpm check`.
- Single author: no `Co-authored-by` trailers, no tool attribution.
- Do not commit or push unless asked. Never commit `.env` files other than `.env.example`.
- When you add or rename a script, update the Commands section here and the README in the same commit.

## Secrets

Secrets live in `.env` (git-ignored). `.env.example` lists every variable with placeholders only.
Never hard-code secrets.
