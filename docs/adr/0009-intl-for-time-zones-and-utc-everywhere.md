# 0009. Platform `Intl` for time zones; UTC instants everywhere else

Status: Accepted

## Context

DST and offset changes must never create hidden overlaps, and the lab zone is a per-instance setting.
Date libraries add weight and their own zone data; the platform already ships IANA data.

## Decision

- Every stored and transmitted time is an absolute instant (`timestamptz`, ISO-8601 with an offset).
  Overlap is computed on instants only, so a repeated or skipped wall-clock hour cannot matter.
- Local time exists in two places only: display (`src/lib/client/format.ts`) and
  `src/lib/booking/zone.ts`, which uses `Intl.DateTimeFormat` to find offsets and to turn a local
  calendar day into a UTC window (23, 24 or 25 hours long).
- The lab zone is stored as `America/Argentina/Buenos_Aires`, the canonical name; the alias
  `America/Buenos_Aires` is accepted by `Intl` as well.
- Property tests cover day windows tiling the timeline in several zones, and integration tests book
  across the New York fall-back hour.

## Consequences

- No date library to keep current. Zone rules follow the Node runtime's ICU data.
- The 15 minute grid is aligned in UTC, which equals local alignment for every zone whose offset is a
  multiple of 15 minutes.
