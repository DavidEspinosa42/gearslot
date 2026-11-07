# Domain

## Glossary

| Term | Meaning |
| ---- | ------- |
| Resource | One bookable physical item, for example "Camera #2". Has a name, category, model, location label and buffer. |
| Model | Resources with the same model are interchangeable ("identical units"), for example three Sony A7 IV bodies. |
| Category | Group used for per-user limits: camera, lens, audio, printer. |
| Reservation | A user's claim on one resource for `[starts_at, ends_at)`. Status `active` or `cancelled`. |
| Buffer | Minutes after `ends_at` during which the resource cannot be booked (cooldown, cleanup). |
| Blocked range | `[starts_at, blocked_until)` where `blocked_until = ends_at + buffer`. This is what conflicts are judged on. |
| Slot | A 15 minute unit. Every start and end falls on a slot boundary. |
| Lab timezone | The IANA zone used for display and for "local day" windows. |
| Idempotency key | Client-generated UUID that identifies one create or cancel attempt. |

## Rules

1. **Half-open intervals.** `[start, end)`. A booking ending at 10:00 does not conflict with one
   starting at 10:00 (without a buffer).
2. **UTC storage, local display.** Everything is `timestamptz`; the UI shows lab-local time with the
   zone name. Because storage is absolute instants, a DST shift cannot create hidden overlaps.
   The shipped zone `America/Argentina/Buenos_Aires` (alias `America/Buenos_Aires`) has no DST, but
   the logic is tested with DST zones too.
3. **Slot grid.** Start and end are multiples of 15 minutes (aligned in UTC, which is aligned in local
   time for every zone whose offset is a multiple of 15 minutes). Duration is 15 minutes to 72 hours.
4. **Time window.** Not in the past (`starts_at >= now`), not more than 30 days ahead
   (`ends_at <= now + 30 days`).
5. **Buffer counts.** The blocked range, not the booked range, is checked for overlap. With a 30 minute
   printer buffer, a job `10:00-12:00` blocks until `12:30`, and a request `12:15-13:00` conflicts.
   The buffer is also what stops a request that ends inside the previous job's range.
6. **Category cap.** A user holds at most N active reservations per category. "Active" means status
   `active` and `ends_at > now`. Finished bookings do not count.
7. **No overlap, ever.** Enforced by the database (invariant 1), not by application code.
8. **Idempotency.** Same key and same body replays the stored response, including a stored `409`.
   Same key with a different body is `422 idempotency_mismatch`.
9. **Cancel is a status change.** Only the owner can cancel. Cancelling frees the blocked range
   immediately (the exclusion constraint applies to `active` rows only).
10. **Reschedule.** A person can move their own active, unfinished booking to another interval on the
    same item. The same rules and the same exclusion constraint apply; a clash is a `409` and the
    old slot is kept. Swap is deferred (docs/adr/0010).
11. **Retention.** Reservation history older than 12 months is purged; idempotency records older than
    7 days are purged.

## Defaults (per-instance settings, not constants)

Stored in `lab_settings` (one row) and `categories`:

| Setting | Default |
| ------- | ------- |
| `timezone` | `America/Argentina/Buenos_Aires` |
| `slot_minutes` | 15 |
| `min_minutes` | 15 |
| `max_minutes` | 4320 (72 h) |
| `horizon_days` | 30 |
| `retention_months` | 12 |
| `categories.max_active_per_user` | 3 (camera), 2 (lens), 3 (audio), 1 (printer) |
| `resources.buffer_minutes` | 0, except 3D printers: 30 |

## Reference scenario

The lab has three identical Sony A7 IV bodies (Camera #1, #2, #3), one Prusa MK4 (30 minute buffer),
lenses and audio recorders. On Monday at 09:00:00.000 the week unlocks.

1. Forty students submit "Camera #2, Friday 14:00-18:00" at the same instant.
2. Exactly one request commits. The other 39 receive `409 conflict`, each with suggestions: the same
   interval on an identical free unit (Camera #1 or #3) and the next free slots of the same length on
   Camera #2.
3. A booking for Camera #2 Friday 18:00-20:00 succeeds, because the ranges touch but do not overlap.
4. A retry of the winner's request with the same `Idempotency-Key` returns the same reservation, not a
   second one.

`pnpm db:seed` loads the lab and `pnpm scenario` reproduces steps 1-4 with dummy users
(`user-001` ... `user-040`). The integration tests run it with the clock fixed at Monday
2026-11-09 09:00:00.000 Buenos Aires time (12:00:00Z), including the touching 18:00-20:00 booking
while the 40-way race is in flight.
