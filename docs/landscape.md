# Landscape

Reviewed 2026-11. Prices and features change; check each project before relying on this table.

| Alternative | What it is | How Gearslot relates |
| ----------- | ---------- | --------------------- |
| Cal.com / Calendly | Scheduling links for people's time | They schedule people against calendars. Gearslot books physical items, with buffers and per-category caps, and the database refuses overlap. |
| Google Calendar resource rooms | Shared calendars as resources | Good for rooms, but conflicts are advisory, there is no per-user cap or buffer, and it needs Google accounts. |
| Booked Scheduler | Open-source PHP resource reservation | Closest functional match and far broader (approvals, groups, admin UI). Heavier to run; Gearslot is one narrow flow built for phones. |
| Asset managers such as Snipe-IT | Inventory and check-out tracking | They track who has the item now. Gearslot plans who gets it next, and does not track check-in. |
| Spreadsheets and chat messages | What many labs use | No enforcement: double bookings are found at the shelf. |
| Generic booking SaaS (Acuity, SimplyBook) | Appointment booking for businesses | Built around staff availability and payments, not interchangeable equipment units. |

## Differentiation

Gearslot does one thing: hand out a conflict-free `[start, end)` block of a specific item, or refuse
at once. Correctness lives in PostgreSQL (an exclusion constraint over the blocked range), so even
forty simultaneous requests for the same slot produce exactly one winner and 39 clean `409`s with
useful alternatives. It stores no personal data beyond an opaque SSO subject and a display name, runs
locally without Docker, and leaves approvals, payments, check-in and an admin UI out of scope.
