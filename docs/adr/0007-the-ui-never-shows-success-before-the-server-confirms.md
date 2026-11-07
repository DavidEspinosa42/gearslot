# 0007. The UI never shows success before the server confirms

Status: Accepted

## Context

On a flaky phone connection an optimistic "Booked!" is dangerous: the request may be lost, may have
been rejected, or may have committed without the response arriving. People then show up for a
camera they do not have, or book twice.

## Decision

- The booking sheet shows success only from a `201` (or a replayed `201`).
- On `409 conflict` the client refreshes availability immediately and offers the suggested identical
  units and next slots; a person must tap again to accept one.
- A request with no answer (offline, timeout, 5xx) leaves an explicit "no answer yet" state. Its retry
  reuses the same `Idempotency-Key`, so the server replays the outcome it already decided.
- An attempt's key is bound to the exact request body: the same body keeps its key, any other body gets
  a new one, and a definitive answer closes the attempt.
- Availability the client has not loaded for the item and week on screen is "unknown", and unknown
  slots cannot be picked.
- Late responses from a sheet that has since changed are ignored for display; the timeline and the
  bookings list carry the truth.

## Consequences

- One extra tap after a conflict, in exchange for never lying to the user.
- The retry path is covered by unit tests of `attemptFor` and by the server-side idempotency tests.
