"use client";

import { useEffect, useRef } from "react";
import { durationPresets } from "@/lib/booking/timeline";
import type { Problem, ReservationDto, Suggestions } from "@/lib/client/api";
import { formatClock, formatDuration, formatRange } from "@/lib/client/format";

export type SheetPhase =
  | { readonly kind: "ready" }
  | { readonly kind: "sending" }
  /** No clear answer from the server. The retry reuses the same Idempotency-Key. */
  | { readonly kind: "unknown" }
  | { readonly kind: "conflict"; readonly suggestions: Suggestions | undefined }
  | { readonly kind: "refused"; readonly problem: Problem }
  | { readonly kind: "done"; readonly reservation: ReservationDto };

interface Props {
  readonly resourceName: string;
  readonly timezone: string;
  readonly start: number;
  readonly minutes: number;
  readonly maxMinutes: number;
  readonly minMinutes: number;
  readonly slotMinutes: number;
  readonly bufferMinutes: number;
  readonly phase: SheetPhase;
  readonly onMinutes: (minutes: number) => void;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  readonly onUseUnit: (resourceId: string) => void;
  readonly onUseSlot: (startsAt: string, endsAt: string) => void;
}

const MINUTE = 60_000;

export function ConfirmSheet(props: Props) {
  const { phase, timezone, start, minutes, onClose } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const end = start + minutes * MINUTE;

  // A native modal dialog traps focus, makes the page behind it inert, and on close returns focus to
  // the control that opened it.
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: move focus when the sheet changes phase
  useEffect(() => {
    heading.current?.focus();
  }, [phase.kind]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="sheet-title"
      onCancel={(event) => {
        event.preventDefault(); // Escape: close through our state so the selection is cleared too
        onClose();
      }}
      className="sheet m-0 mx-auto mb-0 mt-auto w-full max-w-md rounded-t-2xl border border-line bg-card p-5 text-ink shadow-2xl backdrop:bg-ink/40 md:my-auto md:rounded-2xl"
    >
      <h2 id="sheet-title" ref={heading} tabIndex={-1} className="m-0 text-xl font-semibold">
        {titleFor(phase, props.resourceName)}
      </h2>
      <p className="m-0 mt-1 text-lg">{formatRange(start, end, timezone)}</p>

      {phase.kind === "done" ? (
        <Done {...props} reservation={phase.reservation} />
      ) : phase.kind === "conflict" ? (
        <Conflict {...props} suggestions={phase.suggestions} />
      ) : (
        <Editor {...props} />
      )}
    </dialog>
  );
}

function titleFor(phase: SheetPhase, name: string): string {
  switch (phase.kind) {
    case "done":
      return `${name} is booked`;
    case "conflict":
      return "That time was just taken";
    case "unknown":
      return "No answer from the server yet";
    default:
      return `Book ${name}`;
  }
}

function Editor(props: Props) {
  const { phase, minutes, maxMinutes, minMinutes, slotMinutes, bufferMinutes, onMinutes } = props;
  const sending = phase.kind === "sending";
  const presets = durationPresets(maxMinutes, {
    slotMinutes,
    minMinutes,
    maxMinutes,
    horizonDays: 0,
  });

  return (
    <>
      <fieldset className="m-0 mt-4 flex items-center gap-2 border-0 p-0">
        <legend className="sr-only">Length</legend>
        <button
          type="button"
          aria-label="Shorter"
          disabled={sending || minutes - slotMinutes < minMinutes}
          onClick={() => onMinutes(minutes - slotMinutes)}
          className="size-11 rounded-md border border-line text-xl disabled:opacity-30"
        >
          −
        </button>
        <output className="min-w-24 text-center text-lg font-semibold">
          {formatDuration(minutes)}
        </output>
        <button
          type="button"
          aria-label="Longer"
          disabled={sending || minutes + slotMinutes > maxMinutes}
          onClick={() => onMinutes(minutes + slotMinutes)}
          className="size-11 rounded-md border border-line text-xl disabled:opacity-30"
        >
          +
        </button>
        <div className="ml-auto flex flex-wrap justify-end gap-1.5">
          {presets.map((m) => (
            <button
              key={m}
              type="button"
              disabled={sending}
              aria-pressed={m === minutes}
              onClick={() => onMinutes(m)}
              className={`min-h-9 rounded-md border px-2.5 text-sm ${
                m === minutes ? "border-action bg-action text-action-ink" : "border-line"
              }`}
            >
              {formatDuration(m)}
            </button>
          ))}
        </div>
      </fieldset>

      {bufferMinutes > 0 ? (
        <p className="m-0 mt-3 text-sm text-ink-soft">
          Plus {bufferMinutes} min after the booking for cooldown and cleanup, held for you.
        </p>
      ) : null}

      {phase.kind === "unknown" ? (
        <p role="alert" className="m-0 mt-3 rounded-md bg-alert-bg p-3 text-alert">
          The connection dropped before we heard back. The booking may have gone through. Retry is
          safe: it will not book twice.
        </p>
      ) : null}
      {phase.kind === "refused" ? (
        <p role="alert" className="m-0 mt-3 rounded-md bg-alert-bg p-3 text-alert">
          {phase.problem.title}
        </p>
      ) : null}

      <div className="mt-5 flex gap-2">
        <button
          type="button"
          onClick={props.onClose}
          className="min-h-12 rounded-md border border-line px-4 text-base"
        >
          Close
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={props.onConfirm}
          className="min-h-12 flex-1 rounded-md bg-action px-4 text-lg font-semibold text-action-ink disabled:opacity-60"
        >
          {sending ? "Booking…" : phase.kind === "unknown" ? "Retry booking" : "Book it"}
        </button>
      </div>
    </>
  );
}

function Conflict(props: Props & { suggestions: Suggestions | undefined }) {
  const { suggestions, timezone, onUseUnit, onUseSlot, onClose } = props;
  const units = suggestions?.identicalUnits ?? [];
  const slots = suggestions?.nextSlots ?? [];
  return (
    <>
      <p role="alert" className="m-0 mt-3 rounded-md bg-alert-bg p-3 text-alert">
        Someone else booked {props.resourceName} for this time. The timeline now shows what is free.
      </p>
      {units.length > 0 ? (
        <section className="mt-4" aria-label="Same time on another unit">
          <h3 className="m-0 mb-1.5 text-base font-semibold">Same time, another unit</h3>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {units.map((unit) => (
              <li key={unit.resourceId}>
                <button
                  type="button"
                  onClick={() => onUseUnit(unit.resourceId)}
                  className="min-h-11 rounded-md border border-action px-3.5 text-action"
                >
                  {unit.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {slots.length > 0 ? (
        <section className="mt-4" aria-label="Next free times">
          <h3 className="m-0 mb-1.5 text-base font-semibold">Next free on {props.resourceName}</h3>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {slots.map((slot) => (
              <li key={slot.startsAt}>
                <button
                  type="button"
                  onClick={() => onUseSlot(slot.startsAt, slot.endsAt)}
                  className="min-h-11 rounded-md border border-action px-3.5 text-action"
                >
                  {formatClock(Date.parse(slot.startsAt), timezone)}–
                  {formatClock(Date.parse(slot.endsAt), timezone)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {units.length === 0 && slots.length === 0 ? (
        <p className="m-0 mt-3 text-ink-soft">
          Nothing else is free for that length in the next few weeks. Try a shorter booking.
        </p>
      ) : null}
      <div className="mt-5">
        <button
          type="button"
          onClick={onClose}
          className="min-h-12 w-full rounded-md border border-line text-base"
        >
          Pick another time
        </button>
      </div>
    </>
  );
}

function Done(props: Props & { reservation: ReservationDto }) {
  return (
    <>
      <p role="status" className="m-0 mt-3 rounded-md bg-ok-bg p-3 text-ok-ink">
        Confirmed by the server. It is in your bookings.
      </p>
      <div className="mt-5">
        <button
          type="button"
          onClick={props.onClose}
          className="min-h-12 w-full rounded-md bg-action text-lg font-semibold text-action-ink"
        >
          Done
        </button>
      </div>
    </>
  );
}
