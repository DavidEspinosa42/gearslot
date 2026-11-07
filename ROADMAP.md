# Roadmap

## Before you start

Read in this order: `README.md`, `AGENTS.md`, `docs/domain.md`, `docs/adr/`, then this file.

## Initial version (v1)

One screen (pick item, pick slot, confirm), eight endpoints, CLI scripts instead of an admin UI.
PostgreSQL with `btree_gist` and an exclusion constraint guarantees no overlap; create, cancel,
reschedule and swap are idempotent; conflicts return `409` with next-unit and next-slot suggestions. The UI
shows success only after the server confirms. Local development runs on PGlite behind a socket
server; tests run on real PostgreSQL, including the 40-way reference scenario. Effort already spent
is not listed below; the tables are the next work.

## Next work

### Reservations

| Item | Hours |
| ---- | ----: |
| Reschedule screen (the API and its ordered row locks exist) | 6 |
| Swap screen (the API exists, see ADR 0010) | 4 |
| Recurring weekly bookings with all-or-nothing creation | 14 |
| Waitlist that offers a freed slot | 14 |

### Identity and access

| Item | Hours |
| ---- | ----: |
| OIDC login against the institution's SSO (subject claim) | 14 |
| Roles: staff may book beyond the cap, with audit trail | 8 |
| Rate limiting per subject on write endpoints | 5 |

### Equipment lifecycle

These three build on staff roles (see Identity and access). None of them may store contact details
or other personal data beyond the opaque subject and display name.

| Item | Hours |
| ---- | ----: |
| Approvals workflow: items or categories that need staff approval, a `pending` status that holds the slot through the same exclusion constraint, approve and deny actions, expiry of unanswered requests | 16 |
| Check-in and check-out: staff mark handover and return, release of a no-show after a grace period, late-return flag that blocks the next booking's pickup | 14 |
| Damage tracking: condition note on return, an item taken out of service (blocking new bookings like a blackout date), repair status and history, with the same 12-month retention | 12 |

### Offline and mobile

| Item | Hours |
| ---- | ----: |
| Dexie + Serwist installable PWA with cached availability | 16 |
| Offline "intent queue" that retries with the same key | 12 |
| Web push when a waitlisted slot opens | 8 |

### Operations

| Item | Hours |
| ---- | ----: |
| Admin UI for resources, categories, blackout dates | 20 |
| Scheduled purge job and metrics (conflict rate, p95 booking latency) | 8 |
| Load test of the 09:00 rush against hosted PostgreSQL | 8 |
| Backup and restore runbook | 4 |

### Quality

| Item | Hours |
| ---- | ----: |
| Playwright end-to-end tests for the 3-tap flow on a phone viewport | 10 |
| Accessibility audit of the timeline (keyboard, screen reader) | 8 |
| Localisation (es-AR, en) | 8 |

**Total: 209 hours.**

## Out of scope

Payments, email or SMS notifications (the app stores no contact data), calendar sync, multi-lab
tenancy, blockchain-style ledgers.
