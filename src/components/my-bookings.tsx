"use client";

import { useState } from "react";
import type { ReservationDto } from "@/lib/client/api";
import { formatRange } from "@/lib/client/format";

interface Props {
  readonly reservations: readonly ReservationDto[];
  readonly timezone: string;
  /** Resolves to an error message, or undefined when the cancel went through. */
  readonly onCancel: (id: string) => Promise<string | undefined>;
}

export function MyBookings({ reservations, timezone, onCancel }: Props) {
  const [armed, setArmed] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function cancel(id: string) {
    if (armed !== id) {
      setArmed(id);
      setError(undefined);
      return;
    }
    setBusy(id);
    const message = await onCancel(id);
    setBusy(undefined);
    setArmed(undefined);
    setError(message);
  }

  return (
    <section aria-labelledby="mine-title">
      <h2 id="mine-title" className="m-0 mb-2 text-lg font-semibold">
        Your bookings
      </h2>
      {reservations.length === 0 ? (
        <p className="m-0 text-ink-soft">Nothing booked yet. Pick an item and a free time.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {reservations.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-3 rounded-lg border border-line border-l-4 border-l-mine bg-card p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{r.resourceName}</div>
                <div className="text-sm text-ink-soft">
                  {formatRange(Date.parse(r.startsAt), Date.parse(r.endsAt), timezone)}
                </div>
              </div>
              <button
                type="button"
                disabled={busy === r.id}
                onClick={() => cancel(r.id)}
                className={`min-h-11 shrink-0 rounded-md border px-3 text-sm ${
                  armed === r.id ? "border-alert bg-alert-bg text-alert" : "border-line"
                }`}
              >
                {busy === r.id ? "Cancelling…" : armed === r.id ? "Tap again to cancel" : "Cancel"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error !== undefined ? (
        <p role="alert" className="m-0 mt-2 rounded-md bg-alert-bg p-3 text-alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
